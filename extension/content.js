/**
 * Google Meet JA-VI Live Translator - Content Script
 * 1. Dò tìm container phụ đề Meet bền vững qua aria-live & tọa độ màn hình
 * 2. Quan sát MutationObserver, debounce 350ms để chốt câu (final) và gửi bản nháp (interim)
 * 3. Bắt tín hiệu xóa trắng phụ đề để không mất câu khi người nói ngắt nghỉ
 * 4. Tạo Shadow DOM Overlay hiển thị bản dịch tiếng Việt song song mượt mà
 * 5. Đo lường hiệu năng và độ trễ toàn trình
 */

(() => {
  // Tránh inject trùng lặp
  if (window.__GMEET_JA_VI_INJECTED__) return;
  window.__GMEET_JA_VI_INJECTED__ = true;

  console.log("[JA-VI Translator] Content script đang khởi động trên Google Meet...");

  // Cấu hình phiên làm việc
  const sessionId = "meet_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now();
  let sequenceNumber = 0;
  let bgPort = null;
  let isConnectedToServer = false;

  // Cài đặt người dùng (lưu trữ trong chrome.storage.local)
  let settings = {
    enabled: true,
    showOriginal: true,
    enableInterim: true,
    fontSize: "medium", // small, medium, large
    autoFadeSeconds: 25,
    maxCards: 8
  };

  // State theo dõi phụ đề
  let captionObserver = null;
  let currentCaptionContainer = null;
  let lastCapturedText = "";
  let uncommittedText = "";
  let currentSpeaker = "Người tham gia";
  let debounceTimer = null;
  let interimThrottleTimer = null;
  const DEBOUNCE_MS = 380;
  const INTERIM_THROTTLE_MS = 280;

  // Bản đồ lưu các thẻ subtitle đang hiển thị theo sequence number: seq -> element
  const renderedCards = new Map();
  let activeInterimSeq = null;

  // Shadow DOM Host & Elements
  let shadowRoot = null;
  let overlayContainer = null;
  let subtitlesBody = null;
  let statusDot = null;

  // =========================================================================
  // 1. Quản lý kết nối Port với Background Service Worker
  // =========================================================================
  function setupBackgroundPort() {
    try {
      bgPort = chrome.runtime.connect({ name: "meet-caption-port" });

      bgPort.onMessage.addListener((msg) => {
        if (msg.type === "CONNECTION_STATUS") {
          isConnectedToServer = msg.connected;
          updateUiConnectionStatus(msg.connected);
        } else if (msg.type === "TRANSLATION_RESULT") {
          handleTranslationResult(msg.payload);
        }
      });

      bgPort.onDisconnect.addListener(() => {
        console.warn("[JA-VI Translator] Port ngắt kết nối với background, kết nối lại sau 2s...");
        isConnectedToServer = false;
        updateUiConnectionStatus(false);
        bgPort = null;
        setTimeout(setupBackgroundPort, 2000);
      });
    } catch (err) {
      console.warn("[JA-VI Translator] Lỗi tạo port:", err);
      setTimeout(setupBackgroundPort, 2000);
    }
  }

  function sendTranslationRequest(type, text, speaker) {
    if (!settings.enabled || !text || !text.trim()) return;

    sequenceNumber++;
    const currentSeq = sequenceNumber;
    const now = Date.now();

    const payload = {
      type: type, // "interim" hoặc "final"
      text: text.trim(),
      session_id: sessionId,
      seq: currentSeq,
      speaker: speaker || currentSpeaker,
      timestamp: now
    };

    // Nếu là interim, tạo placeholder hiển thị trước cho mượt
    if (type === "interim") {
      activeInterimSeq = currentSeq;
      renderInterimPlaceholder(currentSeq, speaker, text);
    }

    if (bgPort) {
      bgPort.postMessage({
        type: "TRANSLATE_REQUEST",
        payload: payload
      });
    }

    console.log(`[JA-VI Translator][${type.toUpperCase()}] Gửi seq #${currentSeq}: "${text.trim().substring(0, 30)}..."`);
  }

  // =========================================================================
  // 2. Dò tìm container phụ đề Meet một cách bền vững (aria-live + vị trí)
  // =========================================================================
  function findCaptionContainer() {
    // 1. Quét mọi phần tử có thuộc tính aria-live="polite" hoặc aria-live="assertive"
    const liveElements = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');

    for (const el of liveElements) {
      const rect = el.getBoundingClientRect();
      // Phụ đề Meet luôn nằm ở nửa dưới màn hình video
      if (rect.top > window.innerHeight * 0.4 && rect.height > 15 && rect.width > 100) {
        return el;
      }
    }

    // 2. Dự phòng: các class hoặc selector đặc trưng của vùng phụ đề Meet
    const fallbackSelectors = [
      '[jsname="YSxPC"]',
      '.nMDOkf',
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="phụ đề" i]',
      '[role="region"][aria-label*="字幕" i]'
    ];

    for (const selector of fallbackSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top > window.innerHeight * 0.35) {
          return el;
        }
      }
    }

    return null;
  }

  /**
   * Bóc tách tên người nói và nội dung text từ node phụ đề Meet
   */
  function extractCaptionData(container) {
    if (!container) return { speaker: "Người tham gia", text: "" };

    // Google Meet thường chia phụ đề thành các khối theo người nói
    // Tìm các dòng / khối con gần nhất
    let speakerName = "Người tham gia";
    let fullText = "";

    // Thử tìm thẻ tên người nói trong vùng phụ đề
    const speakerEl = container.querySelector('[class*="speaker" i], [class*="name" i], [jsname="W297wb"], .ygicle');
    if (speakerEl && speakerEl.textContent.trim()) {
      speakerName = speakerEl.textContent.trim();
    }

    // Lấy toàn bộ text sạch
    // Loại bỏ tên người nói khỏi text nếu nó bị gộp chung
    let rawText = container.innerText || container.textContent || "";
    
    // Nếu có tên người nói ở đầu, cắt bỏ
    if (speakerName !== "Người tham gia" && rawText.startsWith(speakerName)) {
      rawText = rawText.replace(speakerName, "").trim();
    }

    fullText = rawText.replace(/[\r\n]+/g, " ").trim();

    return {
      speaker: speakerName,
      text: fullText
    };
  }

  /**
   * Khởi động MutationObserver quan sát phụ đề
   */
  function attachCaptionObserver(container) {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }

    currentCaptionContainer = container;
    console.log("[JA-VI Translator] Đã gắn MutationObserver vào container phụ đề Meet!");

    captionObserver = new MutationObserver((mutations) => {
      const { speaker, text } = extractCaptionData(currentCaptionContainer);
      if (speaker) currentSpeaker = speaker;

      // XỬ LÝ ĐẶC BIỆT: Trường hợp Meet xóa trắng caption khi người nói ngắt nghỉ lâu
      if (!text || text.length === 0) {
        if (uncommittedText && uncommittedText.length > 0) {
          console.log("[JA-VI Translator] Meet vừa xóa trắng caption! Chốt ngay câu dang dở:", uncommittedText);
          if (debounceTimer) clearTimeout(debounceTimer);
          sendTranslationRequest("final", uncommittedText, currentSpeaker);
          uncommittedText = "";
          lastCapturedText = "";
        }
        return;
      }

      // Nếu nội dung thay đổi so với lần quan sát trước
      if (text !== lastCapturedText) {
        lastCapturedText = text;
        uncommittedText = text;

        // Xử lý gửi bản nháp tạm thời (interim) để giảm độ trễ trải nghiệm
        if (settings.enableInterim && !interimThrottleTimer) {
          interimThrottleTimer = setTimeout(() => {
            interimThrottleTimer = null;
            if (uncommittedText && uncommittedText === text) {
              sendTranslationRequest("interim", uncommittedText, currentSpeaker);
            }
          }, INTERIM_THROTTLE_MS);
        }

        // Đặt lại bộ đếm Debounce để chốt câu (final)
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (uncommittedText) {
            sendTranslationRequest("final", uncommittedText, currentSpeaker);
            uncommittedText = "";
          }
        }, DEBOUNCE_MS);
      }
    });

    captionObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /**
   * Quét định kỳ để phát hiện khi người dùng bật/tắt phụ đề trong Meet
   */
  function startCaptionContainerScanner() {
    setInterval(() => {
      const container = findCaptionContainer();
      if (container && container !== currentCaptionContainer) {
        attachCaptionObserver(container);
      }
    }, 1500);
  }

  // =========================================================================
  // 3. Xây dựng Overlay UI trong Shadow DOM (Độc lập & Không xung đột CSS)
  // =========================================================================
  async function createOverlayUi() {
    const host = document.createElement("div");
    host.id = "gmeet-trans-host";
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });

    // Nạp overlay.css từ extension
    const cssUrl = chrome.runtime.getURL("overlay.css");
    const linkEl = document.createElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = cssUrl;
    shadowRoot.appendChild(linkEl);

    // Tạo khung overlay
    overlayContainer = document.createElement("div");
    overlayContainer.id = "trans-overlay-container";
    overlayContainer.className = `font-${settings.fontSize}`;

    // Khôi phục vị trí đã lưu từ chrome.storage.local
    try {
      const stored = await chrome.storage.local.get(["overlayPos", "settings"]);
      if (stored.settings) {
        settings = { ...settings, ...stored.settings };
        overlayContainer.className = `font-${settings.fontSize}`;
      }
      if (stored.overlayPos) {
        overlayContainer.style.top = stored.overlayPos.top + "px";
        overlayContainer.style.left = stored.overlayPos.left + "px";
      } else {
        // Mặc định ở góc dưới bên trái, ngay phía trên thanh công cụ Meet
        overlayContainer.style.bottom = "90px";
        overlayContainer.style.left = "24px";
      }
    } catch (e) {
      overlayContainer.style.bottom = "90px";
      overlayContainer.style.left = "24px";
    }

    // Cấu trúc HTML của Overlay
    overlayContainer.innerHTML = `
      <div class="overlay-header">
        <div class="header-left">
          <div class="status-dot ${isConnectedToServer ? "connected" : ""}" id="status-indicator" title="${isConnectedToServer ? "Đã kết nối Server" : "Chưa kết nối Server"}"></div>
          <span class="app-title">Phụ đề Nhật - Việt AI</span>
          <span class="badge-tag">NLLB-200</span>
        </div>
        <div class="header-actions">
          <button class="action-btn" id="btn-clear" title="Xóa các dòng phụ đề cũ">🗑️</button>
          <button class="action-btn" id="btn-minimize" title="Thu nhỏ / Mở rộng">—</button>
        </div>
      </div>
      <div class="subtitles-body" id="subtitles-stream">
        <div class="subtitle-card" style="border-left-color: #34a853;">
          <div class="subtitle-meta">
            <span class="speaker-label" style="color: #81c995;">Hệ thống</span>
          </div>
          <div class="translated-text" style="font-size: 13px; color: #a8dab5;">
            Đã sẵn sàng. Hãy bật phụ đề tiếng Nhật (CC) trong Google Meet để bắt đầu dịch!
          </div>
        </div>
      </div>
    `;

    shadowRoot.appendChild(overlayContainer);

    subtitlesBody = shadowRoot.getElementById("subtitles-stream");
    statusDot = shadowRoot.getElementById("status-indicator");

    // Gắn sự kiện nút bấm
    const btnClear = shadowRoot.getElementById("btn-clear");
    btnClear.addEventListener("click", () => {
      subtitlesBody.innerHTML = "";
      renderedCards.clear();
      activeInterimSeq = null;
    });

    const btnMinimize = shadowRoot.getElementById("btn-minimize");
    btnMinimize.addEventListener("click", () => {
      overlayContainer.classList.toggle("minimized");
      btnMinimize.textContent = overlayContainer.classList.contains("minimized") ? "+" : "—";
    });

    // Kích hoạt tính năng kéo thả (Drag and Drop)
    enableDraggable(overlayContainer, shadowRoot.querySelector(".overlay-header"));
  }

  function updateUiConnectionStatus(connected) {
    if (statusDot) {
      if (connected) {
        statusDot.classList.add("connected");
        statusDot.title = "Đã kết nối Translation Service";
      } else {
        statusDot.classList.remove("connected");
        statusDot.title = "Mất kết nối Translation Service (Đang thử lại...)";
      }
    }
  }

  /**
   * Kéo thả overlay và lưu vị trí vào chrome.storage.local
   */
  function enableDraggable(container, handle) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".action-btn")) return; // Bỏ qua nếu click nút

      isDragging = true;
      container.classList.add("dragging");

      const rect = container.getBoundingClientRect();
      // Chuyển bottom thành top để tính toán vị trí tự do
      container.style.bottom = "auto";
      container.style.top = rect.top + "px";
      container.style.left = rect.left + "px";

      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // Giới hạn trong màn hình
        newLeft = Math.max(10, Math.min(window.innerWidth - container.offsetWidth - 10, newLeft));
        newTop = Math.max(10, Math.min(window.innerHeight - 60, newTop));

        container.style.left = newLeft + "px";
        container.style.top = newTop + "px";
      };

      const onMouseUp = async () => {
        if (!isDragging) return;
        isDragging = false;
        container.classList.remove("dragging");
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);

        // Lưu vị trí vào storage
        const rectAfter = container.getBoundingClientRect();
        try {
          await chrome.storage.local.set({
            overlayPos: { top: Math.round(rectAfter.top), left: Math.round(rectAfter.left) }
          });
        } catch (err) {
          console.warn("[JA-VI Translator] Lỗi lưu vị trí overlay:", err);
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  // =========================================================================
  // 4. Hiển thị dòng dịch (Interim và Final) lên Overlay
  // =========================================================================
  function renderInterimPlaceholder(seq, speaker, originalText) {
    if (!subtitlesBody) return;

    let card = renderedCards.get(seq);
    if (!card) {
      card = document.createElement("div");
      card.className = "subtitle-card interim";
      card.id = `sub-card-${seq}`;
      card.innerHTML = `
        <div class="subtitle-meta">
          <span class="speaker-label">${escapeHtml(speaker)}</span>
          <span class="latency-label">Đang dịch...</span>
        </div>
        ${settings.showOriginal ? `<div class="original-text">${escapeHtml(originalText)}</div>` : ""}
        <div class="translated-text">...</div>
      `;
      subtitlesBody.appendChild(card);
      renderedCards.set(seq, card);
      subtitlesBody.scrollTop = subtitlesBody.scrollHeight;
    } else {
      // Cập nhật text gốc nếu đang nói tiếp
      const origEl = card.querySelector(".original-text");
      if (origEl) origEl.textContent = originalText;
    }
  }

  function handleTranslationResult(result) {
    if (!subtitlesBody) return;

    const { type, seq, original_text, translated_text, processing_time_ms, timestamp } = result;
    const roundtripLatency = timestamp ? (Date.now() - timestamp) : processing_time_ms;

    console.log(`[JA-VI Translator] Nhận kết quả #${seq} (${type}): "${translated_text}" [${processing_time_ms}ms]`);

    let card = renderedCards.get(seq);

    if (card) {
      // Nếu đã có thẻ interim trước đó, cập nhật thành thẻ chính thức
      if (type === "final") {
        card.classList.remove("interim");
      }
      const transEl = card.querySelector(".translated-text");
      if (transEl) transEl.textContent = translated_text;

      const origEl = card.querySelector(".original-text");
      if (origEl) origEl.textContent = original_text;

      const latencyEl = card.querySelector(".latency-label");
      if (latencyEl) {
        latencyEl.textContent = `${Math.round(processing_time_ms)}ms`;
      }
    } else {
      // Thẻ mới tinh chưa từng có interim
      card = document.createElement("div");
      card.className = `subtitle-card ${type === "interim" ? "interim" : ""}`;
      card.id = `sub-card-${seq}`;
      card.innerHTML = `
        <div class="subtitle-meta">
          <span class="speaker-label">${escapeHtml(currentSpeaker)}</span>
          <span class="latency-label">${Math.round(processing_time_ms)}ms</span>
        </div>
        ${settings.showOriginal ? `<div class="original-text">${escapeHtml(original_text)}</div>` : ""}
        <div class="translated-text">${escapeHtml(translated_text)}</div>
      `;
      subtitlesBody.appendChild(card);
      renderedCards.set(seq, card);
    }

    // Tự động cuộn xuống dòng mới nhất
    subtitlesBody.scrollTop = subtitlesBody.scrollHeight;

    // Giới hạn số lượng thẻ hiển thị
    trimOldCards();

    // Hẹn giờ làm mờ dần thẻ sau khoảng thời gian cài đặt
    if (type === "final" && settings.autoFadeSeconds > 0) {
      setTimeout(() => {
        if (card && card.parentElement) {
          card.style.opacity = "0.35";
        }
      }, settings.autoFadeSeconds * 1000);
    }
  }

  function trimOldCards() {
    while (subtitlesBody.children.length > settings.maxCards) {
      const firstChild = subtitlesBody.firstElementChild;
      if (firstChild) {
        const id = firstChild.id.replace("sub-card-", "");
        renderedCards.delete(parseInt(id, 10));
        firstChild.remove();
      } else {
        break;
      }
    }
  }

  function escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Lắng nghe thay đổi cài đặt từ Popup
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      if (overlayContainer) {
        overlayContainer.className = `font-${settings.fontSize}`;
      }
    }
  });

  // =========================================================================
  // 5. Khởi động toàn bộ Content Script
  // =========================================================================
  setupBackgroundPort();
  createOverlayUi();
  startCaptionContainerScanner();

})();
