/**
 * Google Meet JA-VI Live Translator - Background Service Worker (Manifest V3)
 * Quản lý kết nối WebSocket bền vững tới Translation Service cục bộ (ws://127.0.0.1:8765/ws)
 * Tự động kết nối lại (exponential backoff) và chuyển tiếp dữ liệu 2 chiều với Content Script.
 */

const WS_URL = "ws://127.0.0.1:8765/ws";
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000; // Khởi đầu 1s
const MAX_RECONNECT_DELAY = 10000; // Tối đa 10s
let isExplicitlyClosed = false;

// Danh sách các port kết nối từ Content Script của các tab Google Meet
const activePorts = new Set();

/**
 * Cập nhật trạng thái kết nối vào chrome.storage.local để popup và content script có thể đọc
 */
async function updateConnectionStatus(isConnected) {
  try {
    await chrome.storage.local.set({
      wsConnected: isConnected,
      lastStatusUpdate: Date.now()
    });
  } catch (err) {
    console.warn("[Background] Lỗi cập nhật storage status:", err);
  }

  // Bắn thông báo trạng thái tới tất cả các content script đang mở
  broadcastToTabs({
    type: "CONNECTION_STATUS",
    connected: isConnected
  });
}

/**
 * Khởi tạo kết nối WebSocket với server Python
 */
function connectWebSocket(force = false) {
  if (!force && activePorts.size === 0) {
    return;
  }

  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log(`[Background] Đang kết nối tới ${WS_URL}...`);
  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log("[Background] WebSocket đã kết nối thành công!");
      reconnectDelay = 1000; // Reset lại delay khi kết nối thành công
      updateConnectionStatus(true);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Gửi kết quả dịch về cho content script xử lý
        broadcastToTabs({
          type: "TRANSLATION_RESULT",
          payload: data
        });
      } catch (err) {
        console.log("[Background] Lỗi parse dữ liệu từ WebSocket:", err);
      }
    };

    socket.onerror = () => {
      // Dùng console.log để không kích hoạt cờ đỏ trong chrome://extensions/errors
      console.log("[Background] WebSocket chưa kết nối được (server Python có thể chưa bật).");
    };

    socket.onclose = (event) => {
      console.log(`[Background] WebSocket đã đóng (code: ${event.code}). Sẽ thử lại sau ${reconnectDelay}ms...`);
      updateConnectionStatus(false);
      socket = null;

      if (!isExplicitlyClosed && activePorts.size > 0) {
        scheduleReconnect();
      }
    };
  } catch (err) {
    console.log("[Background] Không thể khởi tạo WebSocket:", err);
    if (activePorts.size > 0) {
      scheduleReconnect();
    }
  }
}

/**
 * Lên lịch kết nối lại theo thuật toán Exponential Backoff
 */
function scheduleReconnect() {
  if (reconnectTimer || activePorts.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    if (activePorts.size > 0) {
      connectWebSocket();
    }
  }, reconnectDelay);
}

/**
 * Gửi thông điệp tới tất cả các tab Google Meet đang kết nối
 */
function broadcastToTabs(message) {
  for (const port of activePorts) {
    try {
      port.postMessage(message);
    } catch (e) {
      console.warn("[Background] Lỗi gửi tin tới port, xóa port:", e);
      activePorts.delete(port);
    }
  }
}

/**
 * Gửi dữ liệu từ content script ra server Python qua WebSocket
 */
function sendToWebSocket(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  } else {
    console.warn("[Background] Không thể gửi: WebSocket chưa sẵn sàng, đang thử kết nối lại...");
    connectWebSocket();
    return false;
  }
}

// Lắng nghe kết nối Port từ Content Script
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "meet-caption-port") return;

  console.log("[Background] Nhận kết nối Port từ Google Meet Content Script");
  activePorts.add(port);

  // Gửi ngay trạng thái kết nối hiện tại cho content script
  const isConnected = socket && socket.readyState === WebSocket.OPEN;
  port.postMessage({
    type: "CONNECTION_STATUS",
    connected: isConnected
  });

  // Nếu socket chưa mở, kích hoạt kết nối
  if (!isConnected) {
    connectWebSocket();
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "TRANSLATE_REQUEST") {
      sendToWebSocket(msg.payload);
    } else if (msg.type === "PING") {
      port.postMessage({ type: "PONG" });
    }
  });

  port.onDisconnect.addListener(() => {
    console.log("[Background] Content script ngắt kết nối port");
    activePorts.delete(port);

    // Khi tất cả tab Meet đã đóng, dọn dẹp kết nối và dừng reconnect để tránh báo lỗi mạng
    if (activePorts.size === 0) {
      console.log("[Background] Không còn phòng họp nào mở. Đóng WebSocket tạm thời.");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch (e) {}
        socket = null;
      }
      updateConnectionStatus(false);
    }
  });
});

/**
 * Kiểm tra trạng thái hoạt động của Translation Service qua HTTP health check
 */
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    const res = await fetch("http://127.0.0.1:8765/health", { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch (e) {
    // server down
  }
  return { ok: false };
}

/**
 * Ngắt kết nối WebSocket chủ động theo yêu cầu của người dùng
 */
function disconnectWebSocket() {
  console.log("[Background] Người dùng yêu cầu ngắt kết nối Server.");
  isExplicitlyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch (e) {}
    socket = null;
  }
  updateConnectionStatus(false);
}

// Lắng nghe Message một lần (cho Popup hoặc các query đơn giản)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_STATUS") {
    (async () => {
      const isWsOpen = socket && socket.readyState === WebSocket.OPEN;
      let health = { ok: false };

      if (!isExplicitlyClosed && !isWsOpen) {
        health = await checkServerHealth();
        if (health.ok && (!socket || socket.readyState === WebSocket.CLOSED)) {
          connectWebSocket(true);
        }
      }

      const isConnected = isWsOpen || (!isExplicitlyClosed && health.ok);
      await updateConnectionStatus(isConnected);

      sendResponse({
        connected: isConnected,
        activeTabs: activePorts.size,
        serverOnline: health.ok || isWsOpen,
        isExplicitlyClosed: isExplicitlyClosed
      });
    })();
    return true;
  } else if (message.action === "CONNECT" || message.action === "RECONNECT") {
    isExplicitlyClosed = false;
    reconnectDelay = 1000;
    if (socket) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    connectWebSocket(true);

    (async () => {
      const health = await checkServerHealth();
      const isConnected = (socket && socket.readyState === WebSocket.OPEN) || health.ok;
      await updateConnectionStatus(isConnected);
      sendResponse({
        status: "connected",
        connected: isConnected,
        activeTabs: activePorts.size
      });
    })();
    return true;
  } else if (message.action === "DISCONNECT") {
    disconnectWebSocket();
    sendResponse({
      status: "disconnected",
      connected: false,
      activeTabs: activePorts.size
    });
    return true;
  }
});

// Giữ Service Worker tỉnh táo khi có meeting đang diễn ra (Alarms định kỳ)
if (typeof chrome !== "undefined" && chrome.alarms) {
  try {
    chrome.alarms.create("keepAliveWs", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "keepAliveWs") {
        if (activePorts.size > 0) {
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            connectWebSocket();
          } else {
            // Gửi ping heartbeat nhẹ tới WebSocket server
            try {
              socket.send(JSON.stringify({ type: "ping" }));
            } catch (e) {
              // Ignore
            }
          }
        }
      }
    });
  } catch (err) {
    console.log("[Background] Lỗi cấu hình chrome.alarms:", err);
  }
}

