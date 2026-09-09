/**
 * Google Meet JA-VI Live Translator - Content Script (Refactored Block-Level Architecture)
 *
 * KIẾN TRÚC MỚI: Quản lý độc lập theo từng Speaker Block trong DOM của Google Meet.
 * 1. Không dùng biến toàn cục để lưu text hay timer của cả cuộc họp.
 * 2. Mỗi Speaker Block (DOM Node) có một BlockState riêng (blockId, timers, seq, card UI).
 * 3. Ngăn ngừa triệt để việc ghép nhầm text giữa các người nói (Bug 4).
 * 4. Chống stale response bằng activeRequestId và lifecycle riêng của từng block (Bug 2).
 * 5. Tự động xử lý khi Meet gỡ bỏ block (childList mutation) để chốt câu an toàn.
 * 6. Shadow DOM Overlay hiển thị mượt mà với 2 chế độ (Chỉ Tiếng Việt / Song ngữ).
 * 7. Dual-Transport: Gửi qua WebSocket Port hoặc HTTP Message Fallback, không bao giờ rơi rớt dữ liệu.
 * 8. Khắc phục triệt để lỗi kẹt "Đang dịch..." bằng việc chỉ tạo card khi có text thực tế.
 */

(() => {
  if (window.__GMEET_JA_VI_INJECTED__) return;
  window.__GMEET_JA_VI_INJECTED__ = true;

  console.log("%c[JA-VI Translator]%c Khởi động với Kiến trúc Block-Level...", "color: #1a73e8; font-weight: bold;", "color: inherit;");

  // Cấu hình phiên làm việc
  const sessionId = "meet_" + Math.random().toString(36).substring(2, 9) + "_" + Date.now();
  let blockCounter = 0;
  let bgPort = null;
  let isConnectedToServer = false;

  // Cài đặt người dùng
  let settings = {
    enabled: true,
    displayMode: "both", // "both" (Song ngữ Cả 2) hoặc "vi_only" (Chỉ Tiếng Việt)
    enableInterim: true,
    fontSize: "medium",  // small, medium, large
    autoFadeSeconds: 25,
    maxCards: 8
  };

  // Shadow DOM Host & Elements
  let shadowRoot = null;
  let overlayContainer = null;
  let subtitlesBody = null;
  let statusDot = null;
  let btnModeToggle = null;
  let btnServerPower = null;

  function isExtensionValid() {
    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // =========================================================================
  // 1. Quản lý kết nối Port với Background Service Worker (Dual-Transport)
  // =========================================================================
  function setupBackgroundPort() {
    if (!isExtensionValid()) return;

    try {
      bgPort = chrome.runtime.connect({ name: "meet-caption-port" });

      bgPort.onMessage.addListener((msg) => {
        if (msg.type === "CONNECTION_STATUS") {
          isConnectedToServer = Boolean(msg.connected);
          updateUiConnectionStatus(msg.connected);
        } else if (msg.type === "TRANSLATION_RESULT") {
          handleTranslationResult(msg.payload);
        }
      });

      bgPort.onDisconnect.addListener(() => {
        bgPort = null;
        // Chỉ thử kết nối lại nếu extension context vẫn hợp lệ
        if (isExtensionValid()) {
          setTimeout(setupBackgroundPort, 2000);
        }
      });
    } catch (err) {
      if (!isExtensionValid()) return;
      setTimeout(() => {
        if (isExtensionValid()) setupBackgroundPort();
      }, 2000);
    }
  }

  /**
   * Định kỳ đồng bộ trạng thái kết nối với Background Service Worker
   */
  function syncServerStatus() {
    if (!isExtensionValid()) return;
    try {
      chrome.runtime.sendMessage({ action: "GET_STATUS" }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.connected === "boolean") {
          isConnectedToServer = res.connected;
          updateUiConnectionStatus(res.connected);
        }
      });
    } catch (e) {}
  }

  /**
   * Gửi yêu cầu dịch với cơ chế Dual-Transport (WebSocket Port + HTTP Message Fallback)
   */
  function sendTranslationRequest(blockState, type) {
    if (!settings.enabled || !blockState.lastObservedText || !blockState.lastObservedText.trim()) return;

    const currentText = blockState.lastObservedText.trim();
    // Bỏ qua nếu text chỉ là icon hoặc rác hệ thống
    if (/^(mic_none|mic_off|arrow_downward|closed_caption|volume_up|more_vert)\b/i.test(currentText)) return;
    if (currentText.length === 0) return;

    blockState.activeRequestId++;
    const currentReqId = blockState.activeRequestId;
    const now = Date.now();

    let seqToSend = blockState.blockSeq;
    if (type === "final") {
      blockState.blockSeq++;
      seqToSend = blockState.blockSeq;
      blockState.committedText = currentText;
      blockState.lastSentInterimText = "";
    } else {
      blockState.lastSentInterimText = currentText;
      seqToSend = blockState.blockSeq + 1;
    }

    const payload = {
      type: type, // "interim" hoặc "final"
      session_id: sessionId,
      block_id: blockState.blockId,
      req_id: currentReqId,
      seq: seqToSend,
      speaker: blockState.speaker,
      text: currentText,
      timestamp: now
    };

    let sent = false;
    if (bgPort) {
      try {
        bgPort.postMessage({
          type: "TRANSLATE_REQUEST",
          payload: payload
        });
        sent = true;
      } catch (e) {
        bgPort = null;
      }
    }

    // Nếu Port không gửi được, Fallback gửi qua sendMessage tức thì
    if (!sent && isExtensionValid()) {
      try {
        chrome.runtime.sendMessage({ action: "TRANSLATE", payload: payload }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.data) {
            handleTranslationResult(res.data);
          }
        });
      } catch (err) {}
    }

    console.log(
      `%c[JA-VI][${type.toUpperCase()} SENT]%c [${blockState.blockId}][Req #${currentReqId}][Seq #${seqToSend}] [${blockState.speaker}]: "${currentText.substring(0, 35)}..."`,
      type === "final" ? "color: #34a853; font-weight: bold;" : "color: #fbbc04;",
      "color: inherit;"
    );
  }

  // =========================================================================
  // 2. Mô hình State Machine Theo Từng Speaker Block
  // =========================================================================

  // Map liên kết giữa DOM Element của Speaker Block và BlockState của nó
  const activeBlocks = new Map();
  // Map phụ tra cứu nhanh bằng blockId
  const blocksById = new Map();

  function createBlockState(element, initialSpeaker) {
    blockCounter++;
    const blockId = `blk_${blockCounter}_${Date.now().toString(36)}`;
    const cardId = `sub-card-${blockId}`;

    const state = {
      blockId: blockId,
      element: element,
      speaker: initialSpeaker || "Người tham gia",
      lastObservedText: "",
      lastSentInterimText: "",
      committedText: "",
      activeRequestId: 0,
      blockSeq: 0,
      debounceTimer: null,
      interimTimer: null,
      cardId: cardId,
      cardElement: null,
      isFinalized: false,
      createdAt: Date.now()
    };

    activeBlocks.set(element, state);
    blocksById.set(blockId, state);

    console.log(`%c[JA-VI][BLOCK CREATED]%c ID: ${blockId} | Speaker: "${state.speaker}"`, "color: #1a73e8; font-weight: bold;", "color: inherit;");

    // LƯU Ý: Tuyệt đối KHÔNG tạo thẻ card rác ở đây khi chưa có text!
    // Thẻ card sẽ chỉ được tạo khi phát hiện text thực sự trong getOrCreateOverlayCard().

    return state;
  }

  function finalizeBlock(blockState) {
    if (blockState.isFinalized) return;

    if (blockState.debounceTimer) {
      clearTimeout(blockState.debounceTimer);
      blockState.debounceTimer = null;
    }
    if (blockState.interimTimer) {
      clearTimeout(blockState.interimTimer);
      blockState.interimTimer = null;
    }

    // Nếu còn text chưa chốt, gửi request final
    if (blockState.lastObservedText && blockState.lastObservedText !== blockState.committedText) {
      sendTranslationRequest(blockState, "final");
    }
  }

  function removeBlock(element) {
    const blockState = activeBlocks.get(element);
    if (!blockState) return;

    console.log(`%c[JA-VI][BLOCK REMOVED]%c ID: ${blockState.blockId} | Speaker: "${blockState.speaker}"`, "color: #ea4335; font-weight: bold;", "color: inherit;");

    finalizeBlock(blockState);
    blockState.isFinalized = true;

    activeBlocks.delete(element);

    setTimeout(() => {
      blocksById.delete(blockState.blockId);
    }, 12000);
  }

  // =========================================================================
  // 3. Phân Tích Cấu Trúc DOM Google Meet & Trích Xuất Dữ Liệu Khối
  // =========================================================================

  function findCaptionContainer() {
    // 1. Thử các selector vùng chứa phụ đề chính của Google Meet
    const specificSelectors = [
      'div[jscontroller="D1tHje"]',
      '.a4bvKc',
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="phụ đề" i]',
      '[role="region"][aria-label*="字幕" i]',
      '[role="region"][aria-label*="subtitles" i]'
    ];

    for (const sel of specificSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top > window.innerHeight * 0.25 && rect.height > 10) {
          return el;
        }
      }
    }

    // 2. Nếu tìm thấy .nMDOkf hoặc [jsname="YSxPC"] (hàng phụ đề), lấy container cha chứa tất cả hàng
    const rowEl = document.querySelector('.nMDOkf, [jsname="YSxPC"]');
    if (rowEl) {
      const parent = rowEl.closest('.a4bvKc') || rowEl.closest('div[jscontroller="D1tHje"]') || rowEl.parentElement;
      if (parent) return parent;
    }

    // 3. Dự phòng aria-live (loại bỏ modal, snackbar, toast, nút cuộn)
    const liveElements = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
    for (const el of liveElements) {
      if (el.closest('[role="status"], [role="alert"], .M9Bg4d, .eO2Zfd, [data-mdc-dialog-action]')) continue;
      if (el.querySelector('button, [role="button"]')) continue;

      const rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.35 && rect.height > 15 && rect.width > 80) {
        return el;
      }
    }

    return null;
  }

  /**
   * Xác định phần tử Speaker Block đại diện cho một mutation target trong container
   */
  function getSpeakerBlockElement(targetNode, container) {
    if (!targetNode || !container || targetNode === container) return null;

    let curr = targetNode.nodeType === Node.ELEMENT_NODE ? targetNode : targetNode.parentElement;
    if (!curr || !container.contains(curr)) return null;

    // Duyệt ngược lên cho tới khi phần tử cha là container
    while (curr && curr.parentElement) {
      if (curr.parentElement === container) {
        return curr;
      }
      if (curr.parentElement.parentElement === container && curr.parentElement.children.length > 1) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  /**
   * Trích xuất tên người nói và văn bản phụ đề CHÍNH XÁC từ blockElement
   * Đã loại bỏ các selector chung chung như [class*="name" i] để không xoá nhầm chữ Nhật!
   */
  function extractBlockData(blockElement) {
    if (!blockElement) return { speaker: "Người tham gia", text: "" };

    let speakerName = "";

    // 1. Thử lấy tên từ ảnh avatar (img alt)
    const avatarImg = blockElement.querySelector('img[alt]');
    if (avatarImg && avatarImg.alt && avatarImg.alt.trim()) {
      speakerName = avatarImg.alt.trim();
    }

    // 2. Thử lấy tên từ các phần tử chuẩn của Meet
    if (!speakerName) {
      const nameEl = blockElement.querySelector('[jsname="W297wb"], .ygicle, [data-self-name]');
      if (nameEl && nameEl.textContent.trim()) {
        speakerName = nameEl.textContent.trim();
      }
    }

    // 3. Trích xuất text nội dung phụ đề
    let text = "";
    const textContainer = blockElement.querySelector('[jsname="YSxPC"], .iTTPOb');
    if (textContainer) {
      const clone = textContainer.cloneNode(true);
      clone.querySelectorAll("img, svg, button, [role='button'], i, .google-material-icons, .material-icons, [class*='icon' i]").forEach((el) => el.remove());
      text = clone.innerText || clone.textContent || "";
    } else {
      const clone = blockElement.cloneNode(true);
      clone.querySelectorAll("img, svg, button, [role='button'], i, .google-material-icons, .material-icons, [class*='icon' i]").forEach((el) => el.remove());

      if (speakerName) {
        const cloneName = clone.querySelector('[jsname="W297wb"], .ygicle, [data-self-name]');
        if (cloneName) cloneName.remove();
      }
      text = clone.innerText || clone.textContent || "";
    }

    // Lọc bỏ ký danh icon nếu dính vào text
    text = text.replace(/^(mic_none|mic_off|arrow_downward|closed_caption|volume_up|more_vert|videocam|call_end)\s*/gi, "");
    text = text.replace(/[\r\n]+/g, " ").trim();

    // Nếu văn bản bắt đầu bằng tên người nói, cắt bỏ phần trùng
    if (speakerName && text.startsWith(speakerName)) {
      text = text.substring(speakerName.length).trim();
    }

    return {
      speaker: speakerName || "Người tham gia",
      text: text
    };
  }

  /**
   * Xử lý khi có thay đổi trong một Speaker Block
   */
  function handleBlockMutation(blockElement) {
    const { speaker, text } = extractBlockData(blockElement);

    // QUAN TRỌNG: Nếu chưa có text thực tế hoặc text rỗng -> BỎ QUA HOÀN TOÀN!
    // Tránh sinh card rác hiển thị "Đang dịch..." trên UI.
    if (!text || !text.trim() || text.length === 0) {
      const existingState = activeBlocks.get(blockElement);
      if (existingState && existingState.lastObservedText) {
        finalizeBlock(existingState);
      }
      return;
    }

    let blockState = activeBlocks.get(blockElement);

    if (!blockState) {
      blockState = createBlockState(blockElement, speaker);
    } else if (speaker && speaker !== "Người tham gia" && blockState.speaker === "Người tham gia") {
      blockState.speaker = speaker;
      updateCardSpeaker(blockState);
    }

    // Nếu nội dung text không đổi so với lần trước, bỏ qua
    if (text === blockState.lastObservedText) return;

    blockState.lastObservedText = text;
    blockState.lastUpdatedAt = Date.now();

    // Hiển thị / cập nhật thẻ trên UI với câu gốc tiếng Nhật ngay lập tức
    getOrCreateOverlayCard(blockState, text);

    // Xử lý gửi bản dịch nháp (Interim)
    if (settings.enableInterim) {
      const charDiff = Math.abs(text.length - blockState.lastSentInterimText.length);
      if (text.length >= 3 && charDiff >= 2) {
        if (blockState.interimTimer) clearTimeout(blockState.interimTimer);
        blockState.interimTimer = setTimeout(() => {
          blockState.interimTimer = null;
          if (blockState.lastObservedText === text && !blockState.isFinalized) {
            sendTranslationRequest(blockState, "interim");
          }
        }, 280);
      }
    }

    // Đặt lại Debounce chốt câu (Final) cho riêng block này
    if (blockState.debounceTimer) clearTimeout(blockState.debounceTimer);
    blockState.debounceTimer = setTimeout(() => {
      blockState.debounceTimer = null;
      if (blockState.lastObservedText && !blockState.isFinalized) {
        sendTranslationRequest(blockState, "final");
      }
    }, 450);
  }

  // Observer theo dõi toàn bộ vùng phụ đề
  let mainObserver = null;
  let observedContainer = null;

  function attachObserver(container) {
    if (mainObserver) {
      mainObserver.disconnect();
      mainObserver = null;
    }

    observedContainer = container;
    console.log("[JA-VI Translator] Đã gắn MutationObserver vào Caption Container!");

    mainObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        // 1. Kiểm tra các block bị gỡ bỏ khỏi DOM
        if (mut.type === "childList" && mut.removedNodes.length > 0) {
          for (const node of mut.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (activeBlocks.has(node)) {
                removeBlock(node);
              } else {
                for (const [blockEl] of activeBlocks.entries()) {
                  if (node.contains(blockEl)) {
                    removeBlock(blockEl);
                  }
                }
              }
            }
          }
        }

        // 2. Xác định Speaker Block chứa mutation và xử lý
        const blockEl = getSpeakerBlockElement(mut.target, container);
        if (blockEl) {
          handleBlockMutation(blockEl);
        } else if (mut.type === "childList" && mut.addedNodes.length > 0) {
          for (const node of mut.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const candidate = getSpeakerBlockElement(node, container);
              if (candidate) {
                handleBlockMutation(candidate);
              }
            }
          }
        }
      }
    });

    mainObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Quét ban đầu xem đã có block nào sẵn chưa
    for (const child of container.children) {
      handleBlockMutation(child);
    }
  }

  function startScanner() {
    const timer = setInterval(() => {
      if (!isExtensionValid()) {
        clearInterval(timer);
        if (mainObserver) {
          mainObserver.disconnect();
          mainObserver = null;
        }
        return;
      }
      const container = findCaptionContainer();
      if (container && container !== observedContainer) {
        attachObserver(container);
      }
    }, 1200);
  }

  // =========================================================================
  // 4. Quản Lý Thẻ Overlay UI (Chỉ hiển thị khi có text thực tế)
  // =========================================================================

  /**
   * Lấy hoặc tạo thẻ phụ đề trên Overlay UI - ĐẢM BẢO LUÔN CÓ TEXT GỐC
   */
  function getOrCreateOverlayCard(blockState, text) {
    if (!subtitlesBody || !shadowRoot) return null;

    let card = shadowRoot.getElementById(blockState.cardId);
    if (!card) {
      card = document.createElement("div");
      card.className = "subtitle-card interim";
      card.id = blockState.cardId;
      card.innerHTML = `
        <div class="subtitle-meta">
          <span class="speaker-label">${escapeHtml(blockState.speaker)}</span>
          <span class="latency-label">⚡ Đang dịch...</span>
        </div>
        <div class="original-text">${escapeHtml(text)}</div>
        <div class="translated-text">...</div>
      `;
      subtitlesBody.appendChild(card);
      blockState.cardElement = card;
      subtitlesBody.scrollTop = subtitlesBody.scrollHeight;
      trimOldCards();

      // CƠ CHẾ BẢO VỆ CHỐNG KẸT: Nếu sau 7s chưa có bản dịch, tự động gỡ mác "Đang dịch..."
      setTimeout(() => {
        if (card && card.parentElement) {
          const lat = card.querySelector(".latency-label");
          if (lat && lat.textContent.includes("Đang dịch...")) {
            lat.textContent = "AI";
          }
        }
      }, 7000);
    } else {
      const origEl = card.querySelector(".original-text");
      if (origEl && text) origEl.textContent = text;
      const spEl = card.querySelector(".speaker-label");
      if (spEl && blockState.speaker) spEl.textContent = blockState.speaker;
    }

    return card;
  }

  function updateCardSpeaker(blockState) {
    if (!shadowRoot) return;
    const card = shadowRoot.getElementById(blockState.cardId);
    if (card) {
      const spEl = card.querySelector(".speaker-label");
      if (spEl) spEl.textContent = blockState.speaker;
    }
  }

  function handleTranslationResult(result) {
    if (!subtitlesBody || !shadowRoot) return;

    const { type, block_id, req_id, seq, speaker, original_text, translated_text, processing_time_ms } = result;

    if (!translated_text || !translated_text.trim()) return;

    // Kiểm tra Stale Response
    const blockState = blocksById.get(block_id);
    if (blockState) {
      if (type === "interim") {
        if (blockState.isFinalized || (req_id && req_id < blockState.activeRequestId)) {
          return;
        }
      }
    }

    const cardId = `sub-card-${block_id}`;
    let card = shadowRoot.getElementById(cardId);

    const ms = (typeof processing_time_ms === "number" && !isNaN(processing_time_ms)) ? Math.round(processing_time_ms) : 0;
    const displaySpeaker = speaker || (blockState ? blockState.speaker : "Người tham gia");

    if (card) {
      if (type === "final") {
        card.classList.remove("interim");
      }
      const transEl = card.querySelector(".translated-text");
      if (transEl) transEl.textContent = translated_text;

      const origEl = card.querySelector(".original-text");
      if (origEl && original_text) origEl.textContent = original_text;

      const spEl = card.querySelector(".speaker-label");
      if (spEl) spEl.textContent = displaySpeaker;

      const latencyEl = card.querySelector(".latency-label");
      if (latencyEl) {
        latencyEl.textContent = `${ms}ms`;
      }
    } else {
      card = document.createElement("div");
      card.className = `subtitle-card ${type === "interim" ? "interim" : ""}`;
      card.id = cardId;
      card.innerHTML = `
        <div class="subtitle-meta">
          <span class="speaker-label">${escapeHtml(displaySpeaker)}</span>
          <span class="latency-label">${ms}ms</span>
        </div>
        <div class="original-text">${escapeHtml(original_text || "")}</div>
        <div class="translated-text">${escapeHtml(translated_text)}</div>
      `;
      subtitlesBody.appendChild(card);
    }

    subtitlesBody.scrollTop = subtitlesBody.scrollHeight;
    trimOldCards();

    // Hẹn giờ làm mờ thẻ sau khi câu đã được chốt (final)
    if (type === "final" && settings.autoFadeSeconds > 0) {
      setTimeout(() => {
        if (card && card.parentElement) {
          card.style.opacity = "0.35";
        }
      }, settings.autoFadeSeconds * 1000);
    }

    console.log(
      `%c[JA-VI][RESP RECEIVED]%c [${block_id}][${type.toUpperCase()}] "${translated_text.substring(0, 30)}..." [${ms}ms]`,
      "color: #1a73e8;",
      "color: inherit;"
    );
  }

  function trimOldCards() {
    if (!subtitlesBody) return;
    while (subtitlesBody.children.length > settings.maxCards) {
      const firstChild = subtitlesBody.firstElementChild;
      if (firstChild) {
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

  // =========================================================================
  // 5. Xây dựng Overlay UI trong Shadow DOM (Cách Ly & 2 Chế Độ Phụ Đề)
  // =========================================================================

  async function createOverlayUi() {
    const host = document.createElement("div");
    host.id = "gmeet-trans-host";
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });

    // Nạp overlay.css
    const cssUrl = chrome.runtime.getURL("overlay.css");
    const linkEl = document.createElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = cssUrl;
    shadowRoot.appendChild(linkEl);

    overlayContainer = document.createElement("div");
    overlayContainer.id = "trans-overlay-container";
    overlayContainer.className = `font-${settings.fontSize}`;

    // Khôi phục cài đặt và vị trí
    try {
      const stored = await chrome.storage.local.get(["overlayPos", "settings"]);
      if (stored.settings) {
        settings = { ...settings, ...stored.settings };
        if (stored.settings.showOriginal === false) {
          settings.displayMode = "vi_only";
        }
        overlayContainer.className = `font-${settings.fontSize} ${settings.displayMode === "vi_only" ? "mode-vi-only" : ""}`;
      }
      if (stored.overlayPos) {
        overlayContainer.style.top = stored.overlayPos.top + "px";
        overlayContainer.style.left = stored.overlayPos.left + "px";
      } else {
        overlayContainer.style.bottom = "90px";
        overlayContainer.style.left = "24px";
      }
    } catch (e) {
      overlayContainer.style.bottom = "90px";
      overlayContainer.style.left = "24px";
    }

    overlayContainer.innerHTML = `
      <div class="overlay-header">
        <div class="header-left">
          <div class="status-dot ${isConnectedToServer ? "connected" : ""}" id="status-indicator" title="${isConnectedToServer ? "Đã kết nối Server" : "Chưa kết nối Server"}"></div>
          <span class="app-title">Phụ đề Nhật - Việt AI</span>
          <span class="badge-tag">NLLB-200</span>
        </div>
        <div class="header-actions">
          <button class="server-power-btn ${isConnectedToServer ? "connected" : ""}" id="btn-server-power" title="${isConnectedToServer ? "Server đang kết nối. Nhấp để ngắt kết nối." : "Server chưa kết nối. Nhấp để kết nối lại."}">
            ${isConnectedToServer ? "🟢 Bật" : "🔴 Tắt"}
          </button>
          <button class="mode-toggle-btn ${settings.displayMode === "vi_only" ? "vi-only" : ""}" id="btn-mode-toggle" title="Nhấp để đổi: Song ngữ (Cả 2) hoặc Chỉ Tiếng Việt">
            ${settings.displayMode === "vi_only" ? "🇻🇳 Chỉ Tiếng Việt" : "🌐 Song ngữ (Cả 2)"}
          </button>
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
    btnModeToggle = shadowRoot.getElementById("btn-mode-toggle");
    btnServerPower = shadowRoot.getElementById("btn-server-power");

    // Click vào status dot để kết nối lại
    if (statusDot) {
      statusDot.style.cursor = "pointer";
      statusDot.addEventListener("click", () => {
        if (!isExtensionValid()) return;
        chrome.runtime.sendMessage({ action: "CONNECT" }, (res) => {
          if (res) updateUiConnectionStatus(res.connected);
        });
      });
    }

    if (btnServerPower) {
      btnServerPower.addEventListener("click", async () => {
        if (!isExtensionValid()) return;
        btnServerPower.textContent = "⏳...";
        try {
          if (isConnectedToServer) {
            await chrome.runtime.sendMessage({ action: "DISCONNECT" });
            updateUiConnectionStatus(false);
          } else {
            const res = await chrome.runtime.sendMessage({ action: "CONNECT" });
            if (res) {
              updateUiConnectionStatus(res.connected);
            }
          }
        } catch (e) {
          updateUiConnectionStatus(false);
        }
      });
    }

    function applyDisplayMode(mode) {
      settings.displayMode = mode;
      if (mode === "vi_only") {
        overlayContainer.classList.add("mode-vi-only");
        if (btnModeToggle) {
          btnModeToggle.className = "mode-toggle-btn vi-only";
          btnModeToggle.textContent = "🇻🇳 Chỉ Tiếng Việt";
          btnModeToggle.title = "Đang ở chế độ Chỉ Tiếng Việt. Nhấp để đổi sang Song ngữ (Cả 2).";
        }
      } else {
        overlayContainer.classList.remove("mode-vi-only");
        if (btnModeToggle) {
          btnModeToggle.className = "mode-toggle-btn";
          btnModeToggle.textContent = "🌐 Song ngữ (Cả 2)";
          btnModeToggle.title = "Đang ở chế độ Song ngữ (Cả 2). Nhấp để đổi sang Chỉ Tiếng Việt.";
        }
      }
    }

    applyDisplayMode(settings.displayMode);

    btnModeToggle.addEventListener("click", async () => {
      const nextMode = settings.displayMode === "vi_only" ? "both" : "vi_only";
      applyDisplayMode(nextMode);
      if (!isExtensionValid()) return;
      try {
        await chrome.storage.local.set({
          settings: { ...settings, displayMode: nextMode, showOriginal: nextMode === "both" }
        });
      } catch (err) {}
    });

    const btnClear = shadowRoot.getElementById("btn-clear");
    btnClear.addEventListener("click", () => {
      subtitlesBody.innerHTML = "";
    });

    const btnMinimize = shadowRoot.getElementById("btn-minimize");
    btnMinimize.addEventListener("click", () => {
      overlayContainer.classList.toggle("minimized");
      btnMinimize.textContent = overlayContainer.classList.contains("minimized") ? "+" : "—";
    });

    enableDraggable(overlayContainer, shadowRoot.querySelector(".overlay-header"));
  }

  function updateUiConnectionStatus(connected) {
    isConnectedToServer = Boolean(connected);
    if (statusDot) {
      if (connected) {
        statusDot.classList.add("connected");
        statusDot.title = "Đã kết nối Server";
      } else {
        statusDot.classList.remove("connected");
        statusDot.title = "Chưa kết nối Server (Nhấp để kết nối lại)";
      }
    }
    if (btnServerPower) {
      if (connected) {
        btnServerPower.className = "server-power-btn connected";
        btnServerPower.textContent = "🟢 Bật";
        btnServerPower.title = "Server đang kết nối. Nhấp để ngắt kết nối.";
      } else {
        btnServerPower.className = "server-power-btn";
        btnServerPower.textContent = "🔴 Tắt";
        btnServerPower.title = "Server đang ngắt kết nối. Nhấp để kết nối lại.";
      }
    }
  }

  function enableDraggable(container, handle) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".action-btn") || e.target.closest(".mode-toggle-btn") || e.target.closest(".server-power-btn")) return;

      isDragging = true;
      container.classList.add("dragging");

      const rect = container.getBoundingClientRect();
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

        if (!isExtensionValid()) return;
        const rectAfter = container.getBoundingClientRect();
        try {
          await chrome.storage.local.set({
            overlayPos: { top: Math.round(rectAfter.top), left: Math.round(rectAfter.left) }
          });
        } catch (err) {}
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  try {
    if (isExtensionValid() && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local" && changes.settings) {
          settings = { ...settings, ...changes.settings.newValue };
          if (overlayContainer) {
            overlayContainer.className = `font-${settings.fontSize} ${settings.displayMode === "vi_only" ? "mode-vi-only" : ""}`;
            if (btnModeToggle) {
              if (settings.displayMode === "vi_only") {
                btnModeToggle.className = "mode-toggle-btn vi-only";
                btnModeToggle.textContent = "🇻🇳 Chỉ Tiếng Việt";
              } else {
                btnModeToggle.className = "mode-toggle-btn";
                btnModeToggle.textContent = "🌐 Song ngữ (Cả 2)";
              }
            }
          }
        }
      });
    }
  } catch (e) {}

  // Khởi động toàn bộ
  setupBackgroundPort();
  createOverlayUi();
  startScanner();

  // Định kỳ kiểm tra trạng thái kết nối máy chủ mỗi 4s
  setInterval(() => {
    syncServerStatus();
  }, 4000);

  // Đồng bộ trạng thái ban đầu ngay sau khi nạp UI
  setTimeout(() => {
    syncServerStatus();
  }, 500);

})();
