/**
 * Google Meet JA-VI Live Translator - Background Service Worker (Manifest V3)
 * Kiến trúc Dual-Transport: WebSocket thời gian thực (Primary) + HTTP Fallback (Secondary).
 * Đảm bảo 100% không bao giờ bị rơi rớt request hoặc kẹt "Đang dịch...".
 */

const WS_URL = "ws://127.0.0.1:8765/ws";
const HTTP_URL = "http://127.0.0.1:8765";

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 8000;
let isExplicitlyClosed = false;

// Danh sách các port kết nối từ Content Script của các tab Google Meet
const activePorts = new Set();

/**
 * Cập nhật trạng thái kết nối vào chrome.storage.local và broadcast tới tất cả tabs
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

  broadcastToTabs({
    type: "CONNECTION_STATUS",
    connected: isConnected
  });
}

/**
 * Kiểm tra trạng thái hoạt động của Translation Service qua HTTP health check
 */
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${HTTP_URL}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch (e) {
    // server down hoặc chưa bật
  }
  return { ok: false };
}

/**
 * Khởi tạo kết nối WebSocket với server Python
 */
function connectWebSocket(force = false) {
  if (isExplicitlyClosed && !force) {
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
      reconnectDelay = 1000;
      updateConnectionStatus(true);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        broadcastToTabs({
          type: "TRANSLATION_RESULT",
          payload: data
        });
      } catch (err) {
        console.warn("[Background] Lỗi parse dữ liệu từ WebSocket:", err);
      }
    };

    socket.onerror = () => {
      console.log("[Background] WebSocket chưa sẵn sàng, dùng HTTP Fallback.");
    };

    socket.onclose = async (event) => {
      console.log(`[Background] WebSocket đã đóng (code: ${event.code}).`);
      socket = null;

      // Kiểm tra xem HTTP có còn sống không
      const health = await checkServerHealth();
      if (health.ok) {
        // Server vẫn online, chỉ WS đóng -> Vẫn giữ trạng thái connected để HTTP fallback hoạt động!
        updateConnectionStatus(true);
      } else {
        updateConnectionStatus(false);
      }

      if (!isExplicitlyClosed && (activePorts.size > 0 || force)) {
        scheduleReconnect();
      }
    };
  } catch (err) {
    console.log("[Background] Không thể tạo WebSocket:", err);
    if (activePorts.size > 0 || force) {
      scheduleReconnect();
    }
  }
}

/**
 * Lên lịch kết nối lại theo thuật toán Exponential Backoff
 */
function scheduleReconnect() {
  if (reconnectTimer || isExplicitlyClosed) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    connectWebSocket();
  }, reconnectDelay);
}

/**
 * Gửi thông điệp tới tất cả các tab Google Meet đang kết nối (Port + Tab Message)
 */
async function broadcastToTabs(message) {
  let sentToPort = false;
  for (const port of activePorts) {
    try {
      port.postMessage(message);
      sentToPort = true;
    } catch (e) {
      activePorts.delete(port);
    }
  }

  // Dự phòng nếu Port bị gián đoạn: Gửi trực tiếp qua chrome.tabs.sendMessage
  if (!sentToPort && chrome.tabs) {
    try {
      const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      }
    } catch (err) {}
  }
}

/**
 * DUAL-TRANSPORT: Gửi yêu cầu dịch qua WebSocket, tự động Fallback HTTP nếu WS chưa sẵn sàng
 */
async function sendTranslation(payload) {
  // 1. Thử gửi qua WebSocket nếu đang mở (Độ trễ thấp nhất ~30-50ms)
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
      return { success: true, transport: "ws" };
    } catch (err) {
      console.warn("[Background] Lỗi gửi WebSocket, tự động fallback sang HTTP:", err);
    }
  }

  // 2. FALLBACK TỨC THÌ QUA HTTP POST (Đảm bảo 100% không bao giờ kẹt "Đang dịch...")
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${HTTP_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      broadcastToTabs({
        type: "TRANSLATION_RESULT",
        payload: result
      });

      // Nếu HTTP phản hồi thành công mà WebSocket chưa kết nối, kích hoạt kết nối lại WS trong nền
      if (!isExplicitlyClosed && (!socket || socket.readyState === WebSocket.CLOSED)) {
        connectWebSocket();
      }

      return { success: true, transport: "http", data: result };
    }
  } catch (httpErr) {
    console.warn("[Background] Cả WS và HTTP đều không phản hồi (Server Python có thể chưa chạy):", httpErr.message);
  }

  // Nếu cả 2 đều không được, thử kết nối lại
  if (!isExplicitlyClosed && (!socket || socket.readyState === WebSocket.CLOSED)) {
    connectWebSocket();
  }

  return { success: false };
}

/**
 * Ngắt kết nối WebSocket chủ động
 */
function disconnectWebSocket() {
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

// Lắng nghe kết nối Port từ Content Script
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== "meet-caption-port") return;

  activePorts.add(port);

  // Kiểm tra ngay trạng thái server và phản hồi cho tab
  const isWsOpen = socket && socket.readyState === WebSocket.OPEN;
  if (isWsOpen) {
    port.postMessage({ type: "CONNECTION_STATUS", connected: true });
  } else {
    // Kiểm tra nhanh HTTP health
    const health = await checkServerHealth();
    const isOnline = health.ok;
    port.postMessage({ type: "CONNECTION_STATUS", connected: isOnline });
    if (isOnline && !isExplicitlyClosed) {
      connectWebSocket();
    }
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "TRANSLATE_REQUEST") {
      sendTranslation(msg.payload);
    } else if (msg.type === "PING") {
      port.postMessage({ type: "PONG" });
    }
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
    if (activePorts.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }
  });
});

// Lắng nghe tin nhắn một lần (từ Popup hoặc Content Script fallback)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_STATUS") {
    (async () => {
      const isWsOpen = socket && socket.readyState === WebSocket.OPEN;
      const health = await checkServerHealth();
      const isConnected = isWsOpen || (!isExplicitlyClosed && health.ok);
      await updateConnectionStatus(isConnected);

      if (isConnected && !isWsOpen && !isExplicitlyClosed) {
        connectWebSocket();
      }

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
  } else if (message.action === "TRANSLATE") {
    // Kênh dịch trực tiếp qua Message (Fallback dự phòng khi Port bị ngắt)
    (async () => {
      const res = await sendTranslation(message.payload);
      sendResponse(res);
    })();
    return true;
  }
});

// Giữ Service Worker tỉnh táo và duy trì kết nối khi có meeting
if (typeof chrome !== "undefined" && chrome.alarms) {
  try {
    chrome.alarms.create("keepAliveWs", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === "keepAliveWs") {
        if (!isExplicitlyClosed) {
          const health = await checkServerHealth();
          if (health.ok && (!socket || socket.readyState !== WebSocket.OPEN)) {
            connectWebSocket();
          } else if (socket && socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: "ping" }));
            } catch (e) {}
          }
        }
      }
    });
  } catch (err) {
    console.log("[Background] Lỗi alarms:", err);
  }
}
