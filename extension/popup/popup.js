/**
 * Google Meet JA-VI Live Translator - Popup Script
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const toggleEnable = document.getElementById("toggleEnable");
  const toggleOriginal = document.getElementById("toggleOriginal");
  const toggleInterim = document.getElementById("toggleInterim");
  const fontSizeSelect = document.getElementById("fontSizeSelect");
  const btnReconnect = document.getElementById("btnReconnect");

  // Đọc cài đặt đã lưu
  const stored = await chrome.storage.local.get(["settings", "wsConnected"]);

  let currentSettings = {
    enabled: true,
    showOriginal: true,
    enableInterim: true,
    fontSize: "medium"
  };

  if (stored.settings) {
    currentSettings = { ...currentSettings, ...stored.settings };
  }

  toggleEnable.checked = currentSettings.enabled;
  toggleOriginal.checked = currentSettings.showOriginal;
  toggleInterim.checked = currentSettings.enableInterim;
  fontSizeSelect.value = currentSettings.fontSize;

  // Cập nhật trạng thái hiển thị
  updateStatusDisplay(stored.wsConnected);

  // Hỏi trạng thái thực tế từ background worker
  try {
    const res = await chrome.runtime.sendMessage({ action: "GET_STATUS" });
    if (res) {
      updateStatusDisplay(res.connected);
    }
  } catch (e) {
    // Background worker có thể đang sleep
  }

  function updateStatusDisplay(connected) {
    if (connected) {
      statusDot.classList.add("connected");
      statusText.textContent = "Đã kết nối";
      statusText.style.color = "#81c995";
    } else {
      statusDot.classList.remove("connected");
      statusText.textContent = "Chưa kết nối";
      statusText.style.color = "#f28b82";
    }
  }

  async function saveSettings() {
    currentSettings.enabled = toggleEnable.checked;
    currentSettings.showOriginal = toggleOriginal.checked;
    currentSettings.enableInterim = toggleInterim.checked;
    currentSettings.fontSize = fontSizeSelect.value;

    await chrome.storage.local.set({ settings: currentSettings });
  }

  toggleEnable.addEventListener("change", saveSettings);
  toggleOriginal.addEventListener("change", saveSettings);
  toggleInterim.addEventListener("change", saveSettings);
  fontSizeSelect.addEventListener("change", saveSettings);

  btnReconnect.addEventListener("click", async () => {
    btnReconnect.textContent = "Đang thử lại...";
    btnReconnect.disabled = true;

    try {
      await chrome.runtime.sendMessage({ action: "RECONNECT" });
      setTimeout(async () => {
        const res = await chrome.runtime.sendMessage({ action: "GET_STATUS" });
        if (res) updateStatusDisplay(res.connected);
        btnReconnect.textContent = "Kết nối lại Server";
        btnReconnect.disabled = false;
      }, 1200);
    } catch (e) {
      btnReconnect.textContent = "Kết nối lại Server";
      btnReconnect.disabled = false;
    }
  });
});
