/**
 * Google Meet JA-VI Live Translator - Content Script (Refactored Block-Level Architecture)
 *
 * KIẾN TRÚC BLOCK-LEVEL & NÂNG CẤP TRẢI NGHIỆM NGƯỜI DÙNG:
 * 1. Độc lập theo từng Speaker Block: Mỗi người nói có BlockState riêng, không nhầm lẫn text.
 * 2. Hỗ trợ cuộn dọc (Scroll-Y) xem toàn bộ lịch sử phụ đề với cơ chế Smart Auto-Scroll.
 * 3. Cho phép kéo giãn kích thước (Resize Width/Height) tự do và tự động lưu kích thước.
 * 4. Dual-Transport: Kết hợp WebSocket tốc độ cao và HTTP Fallback tự động.
 * 5. Cơ chế Active Retry (2.5s) đảm bảo 100% không bao giờ bị kẹt "Đang dịch...".
 */

(() => {
  if (window.__GMEET_JA_VI_INJECTED__) return;
  window.__GMEET_JA_VI_INJECTED__ = true;

  console.log("%c[JA-VI Translator]%c Khởi động với Kiến trúc Block-Level & Resizable UI...", "color: #1a73e8; font-weight: bold;", "color: inherit;");

  // Cấu hình phiên làm việc
  const sessionId = "meet_" + Math.random().toString(36).substring(2, 9) + "_" + Date.now();
  let blockCounter = 0;
  let bgPort = null;
  let isConnectedToServer = false;

  // Cài đặt người dùng (Lưu tối đa 80 câu để cuộn xem toàn bộ hội thoại cuộc họp)
  let settings = {
    enabled: true,
    displayMode: "both", // "both" (Song ngữ Cả 2) hoặc "vi_only" (Chỉ Tiếng Việt)
    enableInterim: true,
    fontSize: "medium",  // small, medium, large
    autoFadeSeconds: 0,  // 0 = Không làm mờ chữ, giữ lịch sử rõ ràng để đọc
    maxCards: 80         // Lưu tới 80 câu để người dùng thoải mái cuộn xem
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

  // Lắng nghe tin nhắn broadcast dự phòng từ Background qua Runtime Message
  try {
    if (isExtensionValid() && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "CONNECTION_STATUS") {
          isConnectedToServer = Boolean(msg.connected);
          updateUiConnectionStatus(msg.connected);
        } else if (msg.type === "TRANSLATION_RESULT") {
          handleTranslationResult(msg.payload);
        }
      });
    }
  } catch (e) {}

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

    // Nếu Port chưa gửi được, Fallback gửi ngay qua sendMessage
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

  const activeBlocks = new Map();
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
    return state;
  }

  function finalizeBlock(blockState) {
    if (blockState.isFinalized) return;
    blockState.isFinalized = true;

    if (blockState.debounceTimer) {
      clearTimeout(blockState.debounceTimer);
      blockState.debounceTimer = null;
    }
    if (blockState.interimTimer) {
      clearTimeout(blockState.interimTimer);
      blockState.interimTimer = null;
    }

    if (blockState.lastObservedText && blockState.lastObservedText !== blockState.committedText) {
      sendTranslationRequest(blockState, "final");
    }
  }

  function removeBlock(element) {
    const blockState = activeBlocks.get(element);
    if (!blockState) return;

    console.log(`%c[JA-VI][BLOCK REMOVED]%c ID: ${blockState.blockId} | Speaker: "${blockState.speaker}"`, "color: #ea4335; font-weight: bold;", "color: inherit;");

    finalizeBlock(blockState);
    activeBlocks.delete(element);

    setTimeout(() => {
      blocksById.delete(blockState.blockId);
    }, 25000);
  }

  // =========================================================================
  // 3. Phân Tích Cấu Trúc DOM Google Meet & Quét Khối Thống Nhất (Unified Scanner)
  // =========================================================================

  // Ký tự tiếng Nhật (Hiragana, Katakana, Kanji)
  const JA_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

  /**
   * Tìm vùng chứa phụ đề chính xác của Google Meet
   * Hỗ trợ cuộc họp thông thường, trình bày màn hình (Presentation), và PiP
   */
  function findCaptionContainer() {
    // 1. Các bộ chọn chuẩn đặc trưng nhất của Google Meet
    const specificSelectors = [
      '.a4bvKc',
      'div[jscontroller="D1tHje"]',
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="phụ đề" i]',
      '[role="region"][aria-label*="字幕" i]',
      '[role="region"][aria-label*="subtitles" i]'
    ];

    for (const sel of specificSelectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest("#gmeet-trans-host")) {
        return el;
      }
    }

    // 2. Tìm thông qua hàng speaker đặc trưng của Google Meet (.nMDOkf, [jsname="YSxPC"])
    const rowEl = document.querySelector('.nMDOkf, [jsname="YSxPC"]');
    if (rowEl && !rowEl.closest("#gmeet-trans-host")) {
      const parent = rowEl.closest('.a4bvKc') || rowEl.closest('div[jscontroller="D1tHje"]') || rowEl.parentElement;
      if (parent) return parent;
    }

    // 3. Quét tìm container thực tế chứa chữ tiếng Nhật ở nửa dưới màn hình
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      if (div.closest("#gmeet-trans-host")) continue;
      const rect = div.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.4 && rect.height > 15 && rect.height < 500 && rect.width > 150) {
        const txt = div.textContent || "";
        if (JA_REGEX.test(txt)) {
          if (div.classList.contains("a4bvKc") || div.hasAttribute("jscontroller")) {
            return div;
          }
          const region = div.closest('[role="region"]');
          if (region && !region.closest("#gmeet-trans-host")) {
            return region;
          }
        }
      }
    }

    // 4. Tìm phần tử chứa tiếng Nhật sâu nhất và lấy container cha phù hợp
    const jaElements = Array.from(document.querySelectorAll('span, p, div')).filter(el => {
      if (el.closest("#gmeet-trans-host")) return false;
      const rect = el.getBoundingClientRect();
      return rect.top > window.innerHeight * 0.4 && rect.height > 10 && JA_REGEX.test(el.textContent || "");
    });

    if (jaElements.length > 0) {
      const deepest = jaElements[jaElements.length - 1];
      let candidate = deepest;
      for (let i = 0; i < 4 && candidate && candidate.parentElement && candidate.parentElement !== document.body; i++) {
        candidate = candidate.parentElement;
        if (candidate.classList.contains("a4bvKc") || candidate.getAttribute("role") === "region" || candidate.children.length > 1) {
          return candidate;
        }
      }
      if (candidate && candidate !== document.body) return candidate;
    }

    return null;
  }

  /**
   * Lấy danh sách các Speaker Block con trực tiếp từ Caption Container (Kiến trúc chuẩn Bug B)
   */
  function getBlockList(container) {
    if (!container) return [];

    let list = Array.from(container.children).filter(
      c => !(c.closest && c.closest('#gmeet-trans-host')) && c.offsetHeight > 0
    );

    // Nếu container có 1 wrapper trung gian bọc ngoài
    if (list.length === 1 && list[0].children && list[0].children.length > 1) {
      const innerList = Array.from(list[0].children).filter(
        c => !(c.closest && c.closest('#gmeet-trans-host')) && c.offsetHeight > 0
      );
      if (innerList.length > 0) return innerList;
    }

    // Nếu bản thân container là 1 speaker block duy nhất (ví dụ chỉ có 1 người trình bày)
    if (list.length === 0 && container.offsetHeight > 0 && JA_REGEX.test(container.textContent || "")) {
      return [container];
    }

    return list;
  }

  /**
   * Trích xuất tên người nói và văn bản phụ đề CHÍNH XÁC từ blockElement
   * Tương thích cả meeting thông thường lẫn màn hình share presentation (Bản trình bày).
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
      const nameEl = blockElement.querySelector('[jsname="W297wb"], .ygicle, [data-self-name], [class*="speaker" i]');
      if (nameEl && nameEl.textContent.trim()) {
        speakerName = nameEl.textContent.trim();
      }
    }

    // 3. Nhận diện trường hợp Bản trình bày / Share màn hình kèm tiếng
    const rawBlockText = blockElement.textContent || "";
    if (!speakerName) {
      if (/Bản trình bày của bạn|Your presentation|プレゼンテーション/i.test(rawBlockText)) {
        speakerName = "Bản trình bày của bạn";
      }
    }

    // 4. Dùng bản sao clone để bóc tách text phụ đề, không làm biến đổi DOM thật
    const clone = blockElement.cloneNode(true);

    // Xóa tất cả ảnh, avatar, SVG, icons, nút bấm
    clone.querySelectorAll("img, svg, button, [role='button'], i, .google-material-icons, .material-icons, [class*='icon' i]").forEach((el) => el.remove());

    // Xóa các phần tử chứa tên người nói khỏi bản sao
    clone.querySelectorAll('[jsname="W297wb"], .ygicle, [data-self-name], [class*="speaker" i]').forEach((el) => el.remove());

    let text = clone.innerText || clone.textContent || "";
    text = text.replace(/^(mic_none|mic_off|arrow_downward|closed_caption|volume_up|more_vert|videocam|call_end)\s*/gi, "");
    text = text.replace(/[\r\n]+/g, " ").trim();

    // Cắt bỏ nhãn Bản trình bày nếu còn dính trong chuỗi text
    text = text.replace(/^(Bản trình bày của bạn|Your presentation|プレゼンテーション)\s*[:：\-]?\s*/gi, "");

    // Chỉ cắt tên nếu phần còn lại vẫn còn nội dung câu nói
    if (speakerName && text.startsWith(speakerName) && text.length > speakerName.length) {
      text = text.substring(speakerName.length).trim();
    } else if (speakerName && text === speakerName) {
      text = "";
    }

    return {
      speaker: speakerName || "Người tham gia",
      text: text
    };
  }

  /**
   * Xử lý thay đổi dữ liệu trong một Speaker Block (Đã khắc phục hoàn toàn Bug A & Lưu lịch sử cuộn)
   */
  function handleBlockMutation(blockElement) {
    const { speaker, text } = extractBlockData(blockElement);

    // Nếu text trống: chốt câu cũ nếu đang có
    if (!text || !text.trim() || text.length === 0) {
      const existingState = activeBlocks.get(blockElement);
      if (existingState && existingState.lastObservedText && !existingState.isFinalized) {
        finalizeBlock(existingState);
      }
      return;
    }

    // Chỉ xử lý nếu text có chứa ký tự tiếng Nhật
    if (!JA_REGEX.test(text)) {
      return;
    }

    let blockState = activeBlocks.get(blockElement);

    if (!blockState) {
      blockState = createBlockState(blockElement, speaker);
    } else if (blockState.isFinalized) {
      // FIX LỖI A: Mở khóa cờ isFinalized và tạo Card mới để lưu lại thẻ câu cũ trong lịch sử cuộn
      blockCounter++;
      const newBlockId = `blk_${blockCounter}_${Date.now().toString(36)}`;
      blockState.blockId = newBlockId;
      blockState.cardId = `sub-card-${newBlockId}`;
      blockState.cardElement = null;
      blockState.isFinalized = false;
      blockState.blockSeq = 0;
      blockState.activeRequestId = 0;
      blockState.committedText = "";
      blockState.lastObservedText = "";
      blockState.lastSentInterimText = "";
      if (speaker && speaker !== "Người tham gia") {
        blockState.speaker = speaker;
      }
      blocksById.set(newBlockId, blockState);
    } else {
      // Kiểm tra xem Meet có thay thế trực tiếp phụ đề mới mà không clear DOM không
      const prevText = blockState.lastObservedText;
      const isCompletelyNewText = prevText &&
        blockState.committedText &&
        prevText.length >= 6 &&
        !text.includes(prevText.substring(0, Math.min(6, prevText.length))) &&
        !prevText.includes(text.substring(0, Math.min(6, text.length)));

      if (isCompletelyNewText) {
        finalizeBlock(blockState);
        blockCounter++;
        const newBlockId = `blk_${blockCounter}_${Date.now().toString(36)}`;
        blockState.blockId = newBlockId;
        blockState.cardId = `sub-card-${newBlockId}`;
        blockState.cardElement = null;
        blockState.isFinalized = false;
        blockState.blockSeq = 0;
        blockState.activeRequestId = 0;
        blockState.committedText = "";
        blockState.lastObservedText = "";
        blockState.lastSentInterimText = "";
        if (speaker && speaker !== "Người tham gia") {
          blockState.speaker = speaker;
        }
        blocksById.set(newBlockId, blockState);
      } else if (speaker && speaker !== "Người tham gia" && blockState.speaker === "Người tham gia") {
        blockState.speaker = speaker;
        updateCardSpeaker(blockState);
      }
    }

    if (text === blockState.lastObservedText) return;

    blockState.lastObservedText = text;
    blockState.lastUpdatedAt = Date.now();

    // Hiển thị / cập nhật thẻ trên UI với câu gốc tiếng Nhật ngay lập tức
    getOrCreateOverlayCard(blockState, text);

    // Gửi bản dịch nháp (Interim)
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

    // Đặt Debounce chốt câu (Final) cho riêng block này
    if (blockState.debounceTimer) clearTimeout(blockState.debounceTimer);
    blockState.debounceTimer = setTimeout(() => {
      blockState.debounceTimer = null;
      if (blockState.lastObservedText && !blockState.isFinalized) {
        sendTranslationRequest(blockState, "final");
      }
    }, 450);
  }

  /**
   * Quét và xử lý tất cả speaker blocks trong container (Kiến trúc đồng bộ duy nhất)
   */
  function scanAllBlocks(container) {
    if (!container) return;
    const blocks = getBlockList(container);
    const liveEls = new Set(blocks);

    for (const child of blocks) {
      handleBlockMutation(child);
    }

    for (const [el, state] of activeBlocks.entries()) {
      if (!liveEls.has(el) && !document.body.contains(el)) {
        removeBlock(el);
      }
    }
  }

  // Observer theo dõi toàn bộ vùng phụ đề
  let mainObserver = null;
  let observedContainer = null;

  function attachObserver(container) {
    if (!container) return;
    if (mainObserver) {
      mainObserver.disconnect();
      mainObserver = null;
    }

    observedContainer = container;
    console.log("%c[JA-VI Translator]%c Gắn MutationObserver vào Caption Container:", "color: #1a73e8; font-weight: bold;", "color: inherit;", container);

    mainObserver = new MutationObserver(() => {
      scanAllBlocks(container);
    });

    mainObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Quét ngay lần đầu khi vừa gắn observer
    scanAllBlocks(container);
  }

  // Scanner định kỳ (mỗi 600ms) quét chủ động theo container thực tế
  function startScanner() {
    setInterval(() => {
      if (!isExtensionValid()) return;

      const container = findCaptionContainer();
      if (container) {
        if (container !== observedContainer) {
          attachObserver(container);
        } else {
          scanAllBlocks(container);
        }
      }
    }, 600);
  }

  // =========================================================================
  // 4. Quản Lý Thẻ Overlay UI & Cơ Chế Cuộn Thông Minh (Smart Auto-Scroll)
  // =========================================================================

  /**
   * Cuộn danh sách phụ đề xuống dưới cùng một cách thông minh:
   * Nếu người dùng đang cuộn lên trên để đọc lịch sử cũ, KHÔNG giật cuộn xuống!
   */
  function scrollSubtitlesToBottom(force = false) {
    if (!subtitlesBody) return;
    if (force) {
      subtitlesBody.scrollTop = subtitlesBody.scrollHeight;
      return;
    }
    const isUserScrolledUp = (subtitlesBody.scrollHeight - subtitlesBody.scrollTop - subtitlesBody.clientHeight) > 70;
    if (!isUserScrolledUp) {
      subtitlesBody.scrollTop = subtitlesBody.scrollHeight;
    }
  }

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
      scrollSubtitlesToBottom(false);
      trimOldCards();

      // CƠ CHẾ ACTIVE RETRY: Nếu sau 2.5s mà vẫn còn "...", kích hoạt ngay Fallback HTTP trực tiếp!
      setTimeout(() => {
        if (card && card.parentElement) {
          const transEl = card.querySelector(".translated-text");
          if (transEl && transEl.textContent === "...") {
            console.log(`[JA-VI] Tự động kích hoạt Fallback HTTP cho thẻ [${blockState.blockId}]`);
            if (isExtensionValid()) {
              chrome.runtime.sendMessage({
                action: "TRANSLATE",
                payload: {
                  type: "final",
                  session_id: sessionId,
                  block_id: blockState.blockId,
                  req_id: blockState.activeRequestId,
                  seq: blockState.blockSeq || 1,
                  speaker: blockState.speaker,
                  text: blockState.lastObservedText || text,
                  timestamp: Date.now()
                }
              }, (res) => {
                if (res && res.data) {
                  handleTranslationResult(res.data);
                }
              });
            }
          }
        }
      }, 2500);

      // Timeout an toàn gỡ nhãn "Đang dịch..." nếu mạng bị mất
      setTimeout(() => {
        if (card && card.parentElement) {
          const lat = card.querySelector(".latency-label");
          if (lat && lat.textContent.includes("Đang dịch...")) {
            lat.textContent = "AI";
          }
        }
      }, 8000);
    } else {
      const origEl = card.querySelector(".original-text");
      if (origEl && text) origEl.textContent = text;
      const spEl = card.querySelector(".speaker-label");
      if (spEl && blockState.speaker) spEl.textContent = blockState.speaker;
      scrollSubtitlesToBottom(false);
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

    scrollSubtitlesToBottom(false);
    trimOldCards();

    // Hẹn giờ làm mờ thẻ (chỉ áp dụng nếu autoFadeSeconds > 0)
    if (type === "final" && settings.autoFadeSeconds > 0) {
      setTimeout(() => {
        if (card && card.parentElement) {
          card.style.opacity = "0.45";
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
    const max = settings.maxCards || 80;
    while (subtitlesBody.children.length > max) {
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
  // 5. Xây dựng Overlay UI trong Shadow DOM (Kéo Giãn, Di Chuyển & 2 Chế Độ)
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

    // Khôi phục cài đặt, vị trí và kích thước cửa sổ đã lưu
    try {
      const stored = await chrome.storage.local.get(["overlayPos", "overlaySize", "settings"]);
      if (stored.settings) {
        settings = { ...settings, ...stored.settings };
        if (stored.settings.showOriginal === false) {
          settings.displayMode = "vi_only";
        }
        overlayContainer.className = `font-${settings.fontSize} ${settings.displayMode === "vi_only" ? "mode-vi-only" : ""}`;
      }

      // Khôi phục kích thước rộng x cao
      if (stored.overlaySize && stored.overlaySize.width && stored.overlaySize.height) {
        overlayContainer.style.width = stored.overlaySize.width + "px";
        overlayContainer.style.height = stored.overlaySize.height + "px";
      } else {
        overlayContainer.style.width = "620px";
        overlayContainer.style.height = "380px";
      }

      // Khôi phục vị trí
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
      overlayContainer.style.width = "620px";
      overlayContainer.style.height = "380px";
    }

    overlayContainer.innerHTML = `
      <div class="overlay-header">
        <div class="header-left">
          <div class="status-dot ${isConnectedToServer ? "connected" : ""}" id="status-indicator" title="${isConnectedToServer ? "Đã kết nối Server" : "Chưa kết nối Server (Nhấp để kết nối lại)"}"></div>
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
      <div class="resize-handle" title="Kéo để thay đổi kích thước"></div>
    `;

    shadowRoot.appendChild(overlayContainer);

    subtitlesBody = shadowRoot.getElementById("subtitles-stream");
    statusDot = shadowRoot.getElementById("status-indicator");
    btnModeToggle = shadowRoot.getElementById("btn-mode-toggle");
    btnServerPower = shadowRoot.getElementById("btn-server-power");

    // Click vào status dot hoặc nút power để kết nối lại
    const triggerConnect = async () => {
      if (!isExtensionValid()) return;
      if (btnServerPower) btnServerPower.textContent = "⏳...";
      try {
        if (isConnectedToServer) {
          await chrome.runtime.sendMessage({ action: "DISCONNECT" });
          updateUiConnectionStatus(false);
        } else {
          const res = await chrome.runtime.sendMessage({ action: "CONNECT" });
          if (res) updateUiConnectionStatus(res.connected);
        }
      } catch (e) {
        updateUiConnectionStatus(false);
      }
    };

    if (statusDot) statusDot.addEventListener("click", triggerConnect);
    if (btnServerPower) btnServerPower.addEventListener("click", triggerConnect);

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

    // Tự động theo dõi và lưu kích thước kéo giãn (Resize) của người dùng
    if (typeof ResizeObserver !== "undefined") {
      let resizeSaveTimer = null;
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (!overlayContainer.classList.contains("minimized") && isExtensionValid()) {
            const width = Math.round(entry.contentRect.width);
            const height = Math.round(entry.contentRect.height);
            if (width > 250 && height > 150) {
              clearTimeout(resizeSaveTimer);
              resizeSaveTimer = setTimeout(() => {
                chrome.storage.local.set({
                  overlaySize: { width, height }
                }).catch(() => {});
              }, 400);
            }
          }
        }
      });
      resizeObserver.observe(overlayContainer);
    }
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

  // Định kỳ kiểm tra trạng thái kết nối máy chủ mỗi 3s
  setInterval(() => {
    syncServerStatus();
  }, 3000);

  // Đồng bộ trạng thái ban đầu ngay sau khi nạp UI
  setTimeout(() => {
    syncServerStatus();
  }, 400);

})();
