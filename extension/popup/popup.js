/**
 * Google Meet JA-VI Live Translator - Popup Script
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const toggleEnable = document.getElementById("toggleEnable");
  const modeSelect = document.getElementById("modeSelect");
  const toggleInterim = document.getElementById("toggleInterim");
  const fontSizeSelect = document.getElementById("fontSizeSelect");
  const btnReconnect = document.getElementById("btnReconnect");

  // Đọc cài đặt đã lưu
  const stored = await chrome.storage.local.get(["settings", "wsConnected"]);

  let currentSettings = {
    enabled: true,
    displayMode: "both",
    enableInterim: true,
    fontSize: "medium"
  };

  if (stored.settings) {
    currentSettings = { ...currentSettings, ...stored.settings };
    if (stored.settings.showOriginal === false) {
      currentSettings.displayMode = "vi_only";
    }
  }

  toggleEnable.checked = currentSettings.enabled;
  modeSelect.value = currentSettings.displayMode || "both";
  toggleInterim.checked = currentSettings.enableInterim;
  fontSizeSelect.value = currentSettings.fontSize;

  const serverBadge = document.getElementById("serverBadge");
  const btnToggleConnect = document.getElementById("btnToggleConnect");
  const btnConnectIcon = document.getElementById("btnConnectIcon");
  const btnConnectText = document.getElementById("btnConnectText");

  let isServerConnected = false;

  function updateStatusDisplay(connected, inMeeting = false) {
    isServerConnected = Boolean(connected);

    if (connected) {
      statusDot.classList.add("connected");
      statusText.textContent = inMeeting ? "Đang dịch (Meet)" : "Server sẵn sàng";
      statusText.style.color = "#81c995";

      if (serverBadge) {
        serverBadge.textContent = "🟢 Đã kết nối";
        serverBadge.className = "server-badge connected";
      }
      if (btnToggleConnect) {
        btnToggleConnect.className = "btn-primary btn-disconnect";
        if (btnConnectIcon) btnConnectIcon.textContent = "🔴";
        if (btnConnectText) btnConnectText.textContent = "Ngắt kết nối Server";
      }
    } else {
      statusDot.classList.remove("connected");
      statusText.textContent = "Chưa kết nối Server";
      statusText.style.color = "#f28b82";

      if (serverBadge) {
        serverBadge.textContent = "⚪ Đã ngắt kết nối";
        serverBadge.className = "server-badge";
      }
      if (btnToggleConnect) {
        btnToggleConnect.className = "btn-primary btn-connect";
        if (btnConnectIcon) btnConnectIcon.textContent = "⚡";
        if (btnConnectText) btnConnectText.textContent = "Kết nối Server";
      }
    }
  }

  // Cập nhật trạng thái hiển thị ban đầu
  updateStatusDisplay(stored.wsConnected);

  // Lắng nghe thay đổi trạng thái theo thời gian thực từ storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wsConnected !== undefined) {
      updateStatusDisplay(changes.wsConnected.newValue);
    }
  });

  // Hỏi trạng thái thực tế từ background worker
  try {
    const res = await chrome.runtime.sendMessage({ action: "GET_STATUS" });
    if (res) {
      updateStatusDisplay(res.connected, res.activeTabs > 0);
    }
  } catch (e) {
    // Background worker có thể đang sleep
  }

  async function saveSettings() {
    currentSettings.enabled = toggleEnable.checked;
    currentSettings.displayMode = modeSelect.value;
    currentSettings.showOriginal = modeSelect.value === "both";
    currentSettings.enableInterim = toggleInterim.checked;
    currentSettings.fontSize = fontSizeSelect.value;

    await chrome.storage.local.set({ settings: currentSettings });
  }

  toggleEnable.addEventListener("change", saveSettings);
  modeSelect.addEventListener("change", saveSettings);
  toggleInterim.addEventListener("change", saveSettings);
  fontSizeSelect.addEventListener("change", saveSettings);

  btnToggleConnect.addEventListener("click", async () => {
    btnToggleConnect.disabled = true;
    const isCurrentlyConnected = isServerConnected;

    if (btnConnectText) {
      btnConnectText.textContent = isCurrentlyConnected ? "Đang ngắt kết nối..." : "Đang kết nối...";
    }

    try {
      if (isCurrentlyConnected) {
        // Yêu cầu ngắt kết nối
        const res = await chrome.runtime.sendMessage({ action: "DISCONNECT" });
        updateStatusDisplay(false);
      } else {
        // Yêu cầu kết nối lại
        const res = await chrome.runtime.sendMessage({ action: "CONNECT" });
        if (res) {
          updateStatusDisplay(res.connected, res.activeTabs > 0);
        }
      }
    } catch (e) {
      updateStatusDisplay(false);
    } finally {
      setTimeout(() => {
        btnToggleConnect.disabled = false;
      }, 400);
    }
  });
});
