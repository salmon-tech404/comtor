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

  console.log("%c[JA-VI]%c Extension đã sẵn sàng.", "color: #1a73e8; font-weight: bold;", "color: inherit;");

  // Cấu hình phiên làm việc
  const sessionId = "meet_" + Math.random().toString(36).substring(2, 9) + "_" + Date.now();
  let blockCounter = 0;
  let bgPort = null;
  let isConnectedToServer = false;

  // Cài đặt người dùng (Lưu tối đa 150 câu để cuộn xem toàn bộ hội thoại cuộc họp)
  let settings = {
    enabled: true,
    displayMode: "both", // "both" (Song ngữ Cả 2) hoặc "vi_only" (Chỉ Tiếng Việt)
    enableInterim: true,
    fontSize: "medium",  // small, medium, large
    autoFadeSeconds: 0,  // 0 = Không làm mờ chữ, giữ lịch sử rõ ràng để đọc
    maxCards: 150        // Lưu tới 150 câu để người dùng thoải mái cuộn xem
  };

  // Shadow DOM Host & Elements
  let shadowRoot = null;
  let overlayContainer = null;
  let subtitlesBody = null;
  let statusDot = null;
  let voiceWaveEl = null;
  let voiceWaveTimer = null;
  let btnModeToggle = null;
  let btnServerPower = null;

  /**
   * Kích hoạt hoạt họa sóng âm thanh nhỏ gọn khi có tiếng nói phát ra
   */
  function triggerVoiceWave() {
    if (!voiceWaveEl) return;
    voiceWaveEl.classList.add("active");
    if (voiceWaveTimer) clearTimeout(voiceWaveTimer);
    voiceWaveTimer = setTimeout(() => {
      if (voiceWaveEl) voiceWaveEl.classList.remove("active");
      voiceWaveTimer = null;
    }, 1200);
  }

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
          const prev = isConnectedToServer;
          isConnectedToServer = Boolean(msg.connected);
          updateUiConnectionStatus(msg.connected);
          if (prev !== isConnectedToServer) {
            console.log(
              `%c[JA-VI]%c Trạng thái máy chủ dịch: ${isConnectedToServer ? "🟢 Đã kết nối (ws://127.0.0.1:8765)" : "🔴 Mất kết nối (đang thử lại...)"}`,
              isConnectedToServer ? "color: #34a853; font-weight: bold;" : "color: #ea4335; font-weight: bold;",
              "color: inherit;"
            );
          }
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
   * Tách câu tiếng Nhật theo ranh giới câu (Sentence Segmentation)
   * Tách theo các dấu câu: 。！？!? và ký tự xuống dòng
   */
  function splitJapaneseSentences(text) {
    if (!text) return { completed: [], draft: "" };

    const completed = [];
    let buffer = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      buffer += ch;
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
        const trimmed = buffer.trim();
        if (trimmed.length > 0) {
          completed.push(trimmed);
        }
        buffer = "";
      }
    }

    return {
      completed: completed,
      draft: buffer.trim()
    };
  }

  /**
   * Kiểm tra tên người nói có hợp lệ không (loại bỏ thán từ, ký tự điều khiển, câu thoại lọt vào)
   */
  function isInvalidSpeakerName(name) {
    if (!name || name.trim().length < 2) return true;
    const clean = name.trim();
    // Tên người không bao giờ dài quá 35 ký tự
    if (clean.length > 35) return true;
    // Tên người không bao giờ chứa dấu chấm câu hoặc ngắt câu
    if (/[。！？!?\n\r]/.test(clean)) return true;
    // Tên người không bao giờ kết thúc bằng dấu phẩy, dấu hai chấm
    if (/[、,.:;]$/.test(clean)) return true;
    // Loại bỏ thán từ tiếng Nhật
    if (/^(あの|えっと|ええと|はい|そう|うん|あー|うーん|えー|いや|まあ)[\sー〜\?？\!！,、]*$/i.test(clean)) return true;
    // Loại bỏ các đoạn văn bản hệ thống
    if (/Cuộc gọi này|Chi tiết về cuộc họp|Nhấn vào Mũi tên|presentation audio/i.test(clean)) return true;
    return false;
  }

  /**
   * Bóc tách câu mới từ DOM của Google Meet, loại bỏ các câu đã chốt trong các thẻ trước đó.
   * Google Meet luôn tích luỹ toàn bộ câu nói của speaker trong cùng một vùng DOM.
   * Hàm này đảm bảo thẻ mới chỉ nhận câu mới nói, TUYỆT ĐỐI không lặp lại câu của các thẻ trước.
   */
  function stripFinalizedPrefix(domText, finalizedTexts) {
    if (!domText || !finalizedTexts || finalizedTexts.length === 0) return domText;
    let remaining = domText.trim();

    // 1. So khớp từ chuỗi kết hợp nhiều câu gần nhất đến từng câu đơn lẻ
    for (let i = 0; i < finalizedTexts.length; i++) {
      const combined = finalizedTexts.slice(i).join('');
      const normCombined = combined.replace(/[\s\u3000]+/g, '');
      const normRemaining = remaining.replace(/[\s\u3000]+/g, '');

      if (normRemaining.startsWith(normCombined) && normCombined.length > 0) {
        let matchIdx = 0;
        let normIdx = 0;
        while (matchIdx < remaining.length && normIdx < normCombined.length) {
          if (!/[\s\u3000]/.test(remaining[matchIdx])) {
            normIdx++;
          }
          matchIdx++;
        }
        return remaining.substring(matchIdx).replace(/^[\s\u3000。！？!?,、.:;]+/g, '').trim();
      }
    }

    // 2. Dự phòng (Anchor Matching): Tìm phần đuôi của câu đã chốt gần nhất
    const lastFinalized = finalizedTexts[finalizedTexts.length - 1];
    if (lastFinalized && lastFinalized.length >= 6) {
      const normLast = lastFinalized.replace(/[\s\u3000]+/g, '');
      const anchor = normLast.substring(Math.max(0, normLast.length - 8));
      const anchorIdx = remaining.indexOf(anchor);
      if (anchorIdx !== -1 && (remaining.length - (anchorIdx + anchor.length)) >= 2) {
        return remaining.substring(anchorIdx + anchor.length).replace(/^[\s\u3000。！？!?,、.:;]+/g, '').trim();
      }
    }

    return remaining;
  }

  /**
   * Gửi yêu cầu dịch cho một thẻ phụ đề (Dual-Transport: WebSocket Port + HTTP Message Fallback)
   */
  function sendCardTranslation(cardState, type) {
    if (!settings.enabled || !cardState.currentText || !cardState.currentText.trim()) return;

    const textToSend = cardState.currentText.trim();
    cardState.lastSentText = textToSend;
    cardState.activeRequestId++;
    const reqId = cardState.activeRequestId;

    const payload = {
      type: type, // "interim" hoặc "final"
      session_id: sessionId,
      block_id: cardState.blockId,
      req_id: reqId,
      seq: reqId,
      speaker: cardState.speaker,
      text: textToSend,
      timestamp: Date.now()
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
      `%c[JA-VI][Gửi dịch ${type.toUpperCase()}]%c [${cardState.speaker}]: "${textToSend}"`,
      type === "final" ? "color: #1a73e8; font-weight: bold;" : "color: #fbbc04;",
      "color: inherit;"
    );
  }

  // =========================================================================
  // 2. Mô hình Quản Lý Thẻ Theo Diễn Giả (Speaker-Oriented Card State Machine)
  // =========================================================================

  // Lưu lịch sử các câu đã chốt theo từng diễn giả để loại trừ hoàn toàn việc lặp lại câu cũ
  const speakerFinalizedHistory = new Map(); // speakerName -> string[]

  // Quản lý thẻ phụ đề đang nói dở (chưa chốt) của từng diễn giả
  const activeSpeakerCards = new Map(); // speakerName -> cardState
  const cardsByBlockId = new Map(); // blockId -> cardState

  function createSpeakerCard(speaker) {
    blockCounter++;
    const blockId = `blk_${blockCounter}_${Date.now().toString(36)}`;
    const cardId = `sub-card-${blockId}`;

    const cardState = {
      blockId: blockId,
      cardId: cardId,
      speaker: speaker || "Your Presentation",
      currentText: "",
      currentTranslation: "",
      lastSentText: "",
      activeRequestId: 0,
      translateTimer: null,
      silenceTimer: null,
      isFinalized: false,
      createdAt: Date.now()
    };

    activeSpeakerCards.set(cardState.speaker, cardState);
    cardsByBlockId.set(blockId, cardState);

    return cardState;
  }

  function finalizeSpeakerCard(cardState) {
    if (!cardState || cardState.isFinalized) return;
    cardState.isFinalized = true;

    if (cardState.translateTimer) {
      clearTimeout(cardState.translateTimer);
      cardState.translateTimer = null;
    }
    if (cardState.silenceTimer) {
      clearTimeout(cardState.silenceTimer);
      cardState.silenceTimer = null;
    }

    // Ghi nhận câu đã chốt vào lịch sử của diễn giả để các câu sau không bị lặp lại
    if (cardState.currentText && cardState.currentText.trim()) {
      const text = cardState.currentText.trim();
      let history = speakerFinalizedHistory.get(cardState.speaker);
      if (!history) {
        history = [];
        speakerFinalizedHistory.set(cardState.speaker, history);
      }
      history.push(text);
      if (history.length > 15) history.shift();
    }

    const card = shadowRoot ? shadowRoot.getElementById(cardState.cardId) : null;
    if (card) {
      card.classList.remove("interim");
    }

    // Gửi bản dịch FINAL nếu có văn bản
    if (cardState.currentText && cardState.currentText.trim()) {
      sendCardTranslation(cardState, "final");
    }

    // Gỡ khỏi danh sách thẻ đang hoạt động của diễn giả
    if (activeSpeakerCards.get(cardState.speaker) === cardState) {
      activeSpeakerCards.delete(cardState.speaker);
    }

    // Dọn dẹp bộ nhớ sau 45s để tránh rò rỉ bộ nhớ trong cuộc họp dài
    setTimeout(() => {
      cardsByBlockId.delete(cardState.blockId);
    }, 45000);
  }

  // =========================================================================
  // 3. Phân Tích Cấu Trúc DOM Google Meet & Quét Khối Thống Nhất (Unified Scanner)
  // =========================================================================

  // Ký tự tiếng Nhật (Hiragana, Katakana, Kanji)
  const JA_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

  // Bộ selector kết hợp đa thế hệ giao diện Google Meet (Cũ 2023-2024 & Mới 2025-2026).
  // Đảm bảo tương thích 100% bất kể Google A/B testing hay update class name.
  const ROW_SEL = '.nMDOkf, [jsname="YSxPC"], .nMcdL.bj4p3b, .nMcdL, .bj4p3b';
  const LINE_SEL = '.iTTPOb, [jsname="tgaKEf"], .ygicle.VbkSUe, .VbkSUe';
  const CONTAINER_SEL = '.a4bvKc, [role="region"][aria-label*="caption" i], [role="region"][aria-label*="phụ đề" i], [role="region"][aria-label*="字幕" i], [role="region"][aria-label*="subtitles" i], .vNKgIf.UDinHf, .vNKgIf';

  /**
   * Tìm vùng chứa phụ đề chính xác của Google Meet
   * Hỗ trợ cuộc họp thông thường, trình bày màn hình (Presentation), và Picture-in-Picture (PiP)
   */
  function findCaptionContainer() {
    // 1. ƯU TIÊN SỐ 1: Trực tiếp tìm qua phần tử dòng phụ đề của Google Meet
    const lineEl = document.querySelector(LINE_SEL);
    if (lineEl && !lineEl.closest("#gmeet-trans-host")) {
      const container = lineEl.closest(CONTAINER_SEL) || lineEl.closest(ROW_SEL)?.parentElement || lineEl.parentElement;
      if (container && container !== document.body) {
        return container;
      }
    }

    // 2. ƯU TIÊN SỐ 2: Tìm qua speaker row / turn block của Google Meet
    const rowEl = document.querySelector(ROW_SEL);
    if (rowEl && !rowEl.closest("#gmeet-trans-host")) {
      const container = rowEl.closest(CONTAINER_SEL) || rowEl.parentElement;
      if (container && container !== document.body) {
        return container;
      }
    }

    // 3. ƯU TIÊN SỐ 3: Container chuẩn của Google Meet (region Captions hoặc .a4bvKc đời cũ)
    const staticPrimary = document.querySelector(CONTAINER_SEL);
    if (staticPrimary && !staticPrimary.closest("#gmeet-trans-host") && !staticPrimary.closest('[role="toolbar"]')) {
      return staticPrimary;
    }

    // 4. ƯU TIÊN SỐ 4: Dynamic Scanner - Tìm phần tử lá chứa chữ tiếng Nhật thực tế
    // Tự động nhận diện phụ đề trong mọi biến thể giao diện Meet (kể cả khi đổi class name hay mở PiP)
    const allLeafs = Array.from(
      document.querySelectorAll('body *:not(script):not(style)')
    ).filter((el) => {
      if (el.closest("#gmeet-trans-host")) return false;
      if (el.closest('button, [role="button"], [role="toolbar"], [role="menu"], [role="tooltip"], [tooltip-id]')) return false;
      const text = (el.textContent || "").trim();
      if (!JA_REGEX.test(text)) return false;
      // Chọn phần tử sâu nhất chứa chữ Nhật (không có phần tử con nào khác chứa chữ Nhật)
      const hasJaChild = Array.from(el.children).some(child => JA_REGEX.test(child.textContent || ""));
      if (hasJaChild) return false;
      const rect = el.getBoundingClientRect();
      return rect.height > 2 && rect.width > 2;
    });

    if (allLeafs.length > 0) {
      let container = allLeafs[0].parentElement;
      while (container && container !== document.body) {
        if (container.classList.contains("a4bvKc") || container.classList.contains("vNKgIf") || container.getAttribute("role") === "region") {
          return container;
        }
        const containsAll = allLeafs.every((leaf) => container.contains(leaf));
        if (containsAll && container.offsetHeight < window.innerHeight * 0.7) {
          return container;
        }
        container = container.parentElement;
      }
      const candidate = allLeafs[0].closest(CONTAINER_SEL + ", " + ROW_SEL);
      if (candidate) return candidate.parentElement || candidate;
      return allLeafs[0].parentElement;
    }

    // 5. Region phụ đề rõ ràng
    const regionSelectors = [
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="phụ đề" i]',
      '[role="region"][aria-label*="字幕" i]',
      '[role="region"][aria-label*="subtitles" i]'
    ];
    for (const sel of regionSelectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest("#gmeet-trans-host") && !el.closest('[role="toolbar"]')) {
        return el;
      }
    }

    return null;
  }

  /**
   * Lấy danh sách các Speaker Block con trực tiếp từ Caption Container
   * Ưu tiên tìm các thẻ hàng speaker riêng biệt để không gộp nhiều người nói vào 1
   */
  function getBlockList(container) {
    if (!container || container === document.body) return [];

    // Nếu chính container là một speaker row hoặc line phụ đề
    if (container.matches && (container.matches(ROW_SEL) || container.matches(LINE_SEL))) {
      return [container];
    }

    // 1. ƯU TIÊN SỐ 1: Tìm tất cả các dòng speaker / turn block riêng biệt
    const speakerRows = Array.from(container.querySelectorAll(ROW_SEL)).filter(
      el => !(el.closest && el.closest('#gmeet-trans-host')) && 
            !el.closest('button, [role="button"], [role="toolbar"], [role="menu"]') && 
            el.offsetHeight > 0
    );
    if (speakerRows.length > 0) {
      return speakerRows;
    }

    // 2. ƯU TIÊN SỐ 2: Tìm các phần tử dòng phụ đề
    const captionLines = Array.from(container.querySelectorAll(LINE_SEL)).filter(
      el => !(el.closest && el.closest('#gmeet-trans-host')) && 
            !el.closest('button, [role="button"], [role="toolbar"], [role="menu"]') && 
            el.offsetHeight > 0
    );
    if (captionLines.length > 0) {
      return captionLines;
    }

    // 3. Dự phòng: Duyệt các phần tử con trực tiếp của container
    let list = Array.from(container.children).filter(
      c => !(c.closest && c.closest('#gmeet-trans-host')) && 
           !c.closest('[role="menu"]') && 
           !c.closest('[role="toolbar"]') && 
           !c.hasAttribute('tooltip-id') && 
           !c.querySelector('[tooltip-id^="ucc"]') && 
           c.getAttribute('role') !== 'button' && 
           c.offsetHeight > 0
    );

    // Nếu container có 1 wrapper trung gian bọc ngoài
    if (list.length === 1 && list[0].children && list[0].children.length > 1) {
      const innerRows = Array.from(list[0].querySelectorAll(ROW_SEL + ", " + LINE_SEL)).filter(
        el => !(el.closest && el.closest('#gmeet-trans-host')) && 
              !el.closest('button, [role="button"], [role="toolbar"], [role="menu"]') && 
              el.offsetHeight > 0
      );
      if (innerRows.length > 0) return innerRows;

      const innerList = Array.from(list[0].children).filter(
        c => !(c.closest && c.closest('#gmeet-trans-host')) && 
             !c.closest('[role="menu"]') && 
             !c.closest('[role="toolbar"]') && 
             !c.hasAttribute('tooltip-id') && 
             !c.querySelector('[tooltip-id^="ucc"]') && 
             c.getAttribute('role') !== 'button' && 
             c.offsetHeight > 0
      );
      if (innerList.length > 0) return innerList;
    }

    // Nếu list rỗng nhưng chính container chứa phụ đề tiếng Nhật
    if (list.length === 0 && container.offsetHeight > 0 && JA_REGEX.test(container.textContent || "")) {
      return [container];
    }

    return list;
  }

  /**
   * Trích xuất tên người nói và văn bản phụ đề CHÍNH XÁC từ blockElement
   * Tương thích cả meeting thông thường lẫn màn hình share presentation (Bản trình bày).
   * Tuyệt đối không để lọt rác mã nguồn / script hoặc menu hệ thống vào câu phụ đề.
   */
  function extractBlockData(blockElement) {
    if (!blockElement) return { speaker: "Your Presentation", text: "" };

    // Bảo vệ: Bỏ qua ngay nếu là nút điều khiển hoặc thanh công cụ
    if (blockElement.hasAttribute && (blockElement.hasAttribute('tooltip-id') || blockElement.closest('[role="toolbar"]'))) {
      return { speaker: "Your Presentation", text: "" };
    }

    // 1. Xác định trước phần tử dòng phụ đề để tuyệt đối không nhầm phụ đề thành tên người nói
    const captionEl = blockElement.matches && blockElement.matches(LINE_SEL) 
      ? blockElement 
      : blockElement.querySelector(LINE_SEL);

    let speakerName = "";

    const searchRoot = (blockElement.closest && blockElement.closest(ROW_SEL)) || blockElement;

    // 2. Thử lấy tên từ ảnh avatar (img[alt])
    const avatarImg = searchRoot.querySelector('img[alt]');
    if (avatarImg && avatarImg.alt && avatarImg.alt.trim()) {
      const candidate = avatarImg.alt.trim();
      if (!isInvalidSpeakerName(candidate)) {
        speakerName = candidate;
      }
    }

    // 3. Thử lấy tên từ các phần tử chứa tên chuẩn của Meet (loại trừ captionEl và các phần tử con của nó)
    if (!speakerName) {
      const nameCandidates = Array.from(searchRoot.querySelectorAll('[jsname="W297wb"], [data-self-name], .zsDr5d, .adEfZc, .adE6rb'));
      for (const el of nameCandidates) {
        if (captionEl && (el === captionEl || el.contains(captionEl) || captionEl.contains(el))) continue;
        const candidate = el.textContent.trim();
        if (!isInvalidSpeakerName(candidate)) {
          speakerName = candidate;
          break;
        }
      }
    }

    // 4. Nhận diện trường hợp Bản trình bày / Share màn hình kèm tiếng
    const rawBlockText = searchRoot.textContent || "";
    if (!speakerName) {
      if (/Bản trình bày của bạn|Your presentation|プレゼンテーション/i.test(rawBlockText)) {
        speakerName = "Your Presentation";
      }
    }

    if (!speakerName || isInvalidSpeakerName(speakerName)) {
      speakerName = "Your Presentation";
    }

    let text = "";

    // 5. Bóc tách trực tiếp từ phần tử chứa dòng phụ đề của Meet (captionEl)
    if (captionEl) {
      text = (captionEl.innerText || captionEl.textContent || "").trim();
    } else {
      // 5. Nếu chính blockElement là node lá chứa chữ Nhật
      if (blockElement.children.length === 0 && JA_REGEX.test(blockElement.textContent || "")) {
        text = (blockElement.textContent || "").trim();
      } else {
        // Tìm trực tiếp từ các phần tử lá chứa chữ Nhật bên trong blockElement (Bảo đảm 100% không trượt)
        const jaLeafs = Array.from(blockElement.querySelectorAll('*')).filter(el => 
          el.children.length === 0 && 
          JA_REGEX.test(el.textContent || "") && 
          !el.closest('button, [role="button"], script, style, [role="dialog"], [role="menu"], [tooltip-id]')
        );

        if (jaLeafs.length > 0) {
          text = jaLeafs.map(el => el.textContent.trim()).join(" ").trim();
        } else {
          // 6. Dự phòng: dùng clone nhưng loại trừ triệt để UI/scripts
          const clone = blockElement.cloneNode(true);
          clone.querySelectorAll(
            "script, style, noscript, template, dialog, [role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'], nav, header, img, svg, button, [role='button'], i, .google-material-icons, .material-icons, [class*='icon' i], [jsname='W297wb'], [data-self-name]"
          ).forEach((el) => el.remove());

          text = clone.innerText || clone.textContent || "";
          text = text.replace(/^(mic_none|mic_off|arrow_downward|closed_caption|volume_up|more_vert|videocam|call_end)\s*/gi, "");
          text = text.replace(/[\r\n]+/g, " ").trim();
          text = text.replace(/^(Bản trình bày của bạn|Your presentation|プレゼンテーション)\s*[:：\-]?\s*/gi, "");

          if (speakerName && text.startsWith(speakerName) && text.length > speakerName.length) {
            text = text.substring(speakerName.length).trim();
          } else if (speakerName && text === speakerName) {
            text = "";
          }
        }
      }
    }

    // 7. BỘ LỌC BẢO VỆ CHỐNG RÁC HỆ THỐNG / SCRIPT NHÚNG:
    if (!text || text.length > 800 || text.length < 1) {
      return { speaker: speakerName, text: "" };
    }
    if (/Cuộc gọi này|Chi tiết về cuộc họp|Nhấn vào Mũi tên|window\.wiz|AF_initData|Tiếng Ả Rập|Trò chuyện với|Mở phần cài đặt|Bản trình bày của bạnBạn đang|Một tiện ích bổ sung|Tùy chọn khác|Rời khỏi cuộc gọi/i.test(text)) {
      return { speaker: speakerName, text: "" };
    }
    if (!JA_REGEX.test(text)) {
      return { speaker: speakerName, text: "" };
    }

    return {
      speaker: speakerName,
      text: text
    };
  }

  /**
   * Xử lý thay đổi dữ liệu trong một Speaker Block
   * Tự động loại bỏ câu đã chốt của các thẻ trước, không lặp lại câu cũ, không tách vụn câu dở
   */
  function handleBlockMutation(blockElement) {
    const { speaker, text } = extractBlockData(blockElement);

    // Bỏ qua nếu text trống hoặc không chứa tiếng Nhật
    if (!text || !text.trim() || !JA_REGEX.test(text)) {
      return;
    }

    // Kích hoạt hiệu ứng sóng âm thanh trên thanh tiêu đề
    triggerVoiceWave();

    // 1. Loại bỏ các câu đã chốt từ các thẻ trước để TUYỆT ĐỐI không lặp lại câu cũ
    const history = speakerFinalizedHistory.get(speaker) || [];
    const freshText = stripFinalizedPrefix(text, history);

    // Nếu toàn bộ text trong DOM đã được chốt ở các thẻ trước đó -> Bỏ qua
    if (!freshText || !freshText.trim() || !JA_REGEX.test(freshText)) {
      return;
    }

    // 2. Lấy thẻ đang hoạt động của diễn giả này
    let cardState = activeSpeakerCards.get(speaker);

    // Nếu chưa có thẻ hoặc thẻ trước đã chốt -> Mở thẻ mới cho câu mới
    if (!cardState || cardState.isFinalized) {
      // Nếu có diễn giả khác đang nói mà chưa chốt, chốt lại
      for (const [spk, otherCard] of activeSpeakerCards.entries()) {
        if (spk !== speaker && !otherCard.isFinalized) {
          finalizeSpeakerCard(otherCard);
        }
      }
      cardState = createSpeakerCard(speaker);
    } else if (speaker && speaker !== "Your Presentation" && cardState.speaker === "Your Presentation") {
      cardState.speaker = speaker;
      updateCardSpeaker(cardState);
    }

    // Nếu văn bản không thay đổi thì bỏ qua
    if (freshText === cardState.currentText) return;

    cardState.currentText = freshText;

    // Log luồng chính: Nhận văn bản phụ đề đang cập nhật
    console.log(
      `%c[JA-VI][Nhận phụ đề]%c [${cardState.speaker}]: "${freshText}"`,
      "color: #ea8600; font-weight: bold;",
      "color: inherit;"
    );

    // Cập nhật câu tiếng Nhật đầy đủ lên thẻ hiện tại ngay lập tức
    renderCard(
      cardState.cardId, 
      cardState.speaker, 
      cardState.currentText, 
      cardState.currentTranslation || "...", 
      "interim"
    );

    // 3. Debounce gửi bản dịch INTERIM (350ms)
    if (cardState.translateTimer) clearTimeout(cardState.translateTimer);
    cardState.translateTimer = setTimeout(() => {
      cardState.translateTimer = null;
      if (!cardState.isFinalized && cardState.currentText === freshText) {
        sendCardTranslation(cardState, "interim");
      }
    }, 350);

    // 4. Debounce chốt câu (FINAL):
    // - Nếu kết thúc bằng dấu chấm câu tiếng Nhật (。！？!?): chờ 2000ms (2s)
    // - Nếu nói lửng lơ chưa hết câu: chờ 4000ms (4s)
    // - Nếu câu quá dài (> 180 ký tự) và có ngắt dấu: chốt sau 1500ms
    const endsWithPunct = /[。！？!?]$/.test(freshText.trim());
    const isTooLong = freshText.length > 180 && /[、,。！？!?]/.test(freshText);
    const silenceWaitMs = isTooLong ? 1500 : (endsWithPunct ? 2000 : 4000);

    if (cardState.silenceTimer) clearTimeout(cardState.silenceTimer);
    cardState.silenceTimer = setTimeout(() => {
      cardState.silenceTimer = null;
      if (!cardState.isFinalized) {
        finalizeSpeakerCard(cardState);
      }
    }, silenceWaitMs);
  }

  /**
   * Quét và xử lý tất cả speaker blocks trong container (Kiến trúc đồng bộ duy nhất)
   */
  function scanAllBlocks(container) {
    if (!container) return;
    const blocks = getBlockList(container);

    for (const child of blocks) {
      handleBlockMutation(child);
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
    console.log("%c[JA-VI]%c Đã phát hiện và gắn theo dõi phụ đề Google Meet.", "color: #34a853; font-weight: bold;", "color: inherit;");

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

  // Theo dõi DOM theo sự kiện (Event-Driven) - Tự động phát hiện và gắn kết container phụ đề
  let rootObserver = null;
  let domCheckTimeout = null;

  function checkAndAttachContainer() {
    if (!isExtensionValid()) return;

    // Tìm container phụ đề tốt nhất hiện có trên trang
    const bestContainer = findCaptionContainer();

    if (bestContainer) {
      // Nếu chưa theo dõi container nào, hoặc container tốt nhất khác với container đang theo dõi
      if (bestContainer !== observedContainer) {
        attachObserver(bestContainer);
      }
    } else if (observedContainer && !document.body.contains(observedContainer)) {
      if (mainObserver) {
        mainObserver.disconnect();
        mainObserver = null;
      }
      observedContainer = null;
    }
  }

  function initCaptionWatcher() {
    // 1. Kiểm tra ngay khi khởi tạo
    checkAndAttachContainer();

    // 2. Theo dõi biến đổi DOM của trang (MutationObserver)
    rootObserver = new MutationObserver(() => {
      if (domCheckTimeout) return;
      domCheckTimeout = setTimeout(() => {
        domCheckTimeout = null;
        checkAndAttachContainer();
      }, 250);
    });

    rootObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // 3. Watchdog định kỳ 2 giây (đảm bảo bắt kịp khi Meet đổi sang PiP hoặc chia sẻ màn hình)
    setInterval(() => {
      checkAndAttachContainer();
    }, 2000);
  }

  // =========================================================================
  // 4. Quản Lý Thẻ Overlay UI, Nút Sao Chép & Cơ Chế Cuộn Thông Minh (Smart Auto-Scroll)
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
   * Hiển thị hoặc cập nhật thẻ phụ đề trên Overlay UI
   * Tích hợp hàng bản dịch (.translated-row) và nút Sao chép (.card-copy-btn)
   */
  function renderCard(cardId, speaker, originalText, translatedText, type = "final", latencyMs = null) {
    if (!subtitlesBody || !shadowRoot) return null;

    let card = shadowRoot.getElementById(cardId);
    const latencyLabel = latencyMs !== null ? `${latencyMs}ms` : (type === "interim" ? "⚡ Đang dịch..." : "...");

    if (!card) {
      card = document.createElement("div");
      card.className = `subtitle-card ${type === "interim" ? "interim" : ""}`;
      card.id = cardId;
      card.innerHTML = `
        <div class="subtitle-meta">
          <span class="speaker-label">${escapeHtml(speaker)}</span>
          <span class="latency-label">${latencyLabel}</span>
        </div>
        <div class="original-text">${escapeHtml(originalText || "")}</div>
        <div class="translated-row">
          <div class="translated-text">${escapeHtml(translatedText || "...")}</div>
          <button class="card-copy-btn" title="Sao chép bản dịch" type="button">📋</button>
        </div>
      `;
      subtitlesBody.appendChild(card);
      scrollSubtitlesToBottom(false);
      trimOldCards();

      // CƠ CHẾ ACTIVE RETRY: Nếu sau 2.5s mà vẫn còn "...", kích hoạt ngay Fallback HTTP trực tiếp!
      if (type === "final") {
        setTimeout(() => {
          if (card && card.parentElement) {
            const transEl = card.querySelector(".translated-text");
            if (transEl && transEl.textContent === "...") {
              console.log(`[JA-VI] Tự động kích hoạt Fallback HTTP cho thẻ [${cardId}]`);
              if (isExtensionValid()) {
                const blockId = cardId.replace(/^sub-card-/, "");
                chrome.runtime.sendMessage({
                  action: "TRANSLATE",
                  payload: {
                    type: "final",
                    session_id: sessionId,
                    block_id: blockId,
                    req_id: 1,
                    seq: 1,
                    speaker: speaker,
                    text: originalText,
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
            if (lat && lat.textContent.includes("...")) {
              lat.textContent = "AI";
            }
          }
        }, 8000);
      }
    } else {
      if (type === "final") {
        card.classList.remove("interim");
      } else {
        card.classList.add("interim");
      }

      const origEl = card.querySelector(".original-text");
      if (origEl && originalText) origEl.textContent = originalText;

      const spEl = card.querySelector(".speaker-label");
      if (spEl && speaker) spEl.textContent = speaker;

      const transEl = card.querySelector(".translated-text");
      if (transEl && translatedText && translatedText !== "...") {
        transEl.textContent = translatedText;
      }

      const latencyEl = card.querySelector(".latency-label");
      if (latencyEl && latencyLabel) {
        latencyEl.textContent = latencyLabel;
      }

      scrollSubtitlesToBottom(false);
    }

    return card;
  }

  function updateCardSpeaker(cardState) {
    if (!shadowRoot || !cardState) return;
    const card = shadowRoot.getElementById(cardState.cardId);
    if (card) {
      const spEl = card.querySelector(".speaker-label");
      if (spEl) spEl.textContent = cardState.speaker;
    }
  }

  function handleTranslationResult(result) {
    if (!subtitlesBody || !shadowRoot) return;

    const { type, block_id, req_id, seq, speaker, original_text, translated_text, processing_time_ms } = result;

    if (!translated_text || !translated_text.trim()) return;

    const cardState = cardsByBlockId.get(block_id);
    if (cardState) {
      // Kiểm tra Stale Response
      if (type === "interim" && (cardState.isFinalized || (req_id && req_id < cardState.activeRequestId))) {
        return;
      }
      cardState.currentTranslation = translated_text;
    }

    const cardId = `sub-card-${block_id}`;
    let card = shadowRoot.getElementById(cardId);

    const ms = (typeof processing_time_ms === "number" && !isNaN(processing_time_ms)) ? Math.round(processing_time_ms) : 0;
    const displaySpeaker = speaker || (cardState ? cardState.speaker : "Your Presentation");
    const displayOriginal = cardState ? cardState.currentText : (original_text || "");
    const displayTranslated = translated_text;

    if (card) {
      if (type === "final") {
        card.classList.remove("interim");
      }
      const transEl = card.querySelector(".translated-text");
      if (transEl) transEl.textContent = displayTranslated;

      const origEl = card.querySelector(".original-text");
      if (origEl && displayOriginal) origEl.textContent = displayOriginal;

      const spEl = card.querySelector(".speaker-label");
      if (spEl && displaySpeaker) spEl.textContent = displaySpeaker;

      const latencyEl = card.querySelector(".latency-label");
      if (latencyEl) {
        latencyEl.textContent = `${ms}ms`;
      }
    } else {
      // Nếu là interim mà thẻ đã không còn tồn tại, bỏ qua không tạo thẻ mồ côi
      if (type === "interim") return;
      card = renderCard(cardId, displaySpeaker, displayOriginal, displayTranslated, "final", ms);
    }

    scrollSubtitlesToBottom(false);
    trimOldCards();

    // Hẹn giờ làm mờ thẻ (chỉ áp dụng nếu autoFadeSeconds > 0)
    if (type === "final" && settings.autoFadeSeconds > 0) {
      const targetCard = shadowRoot.getElementById(cardId);
      if (targetCard) {
        setTimeout(() => {
          if (targetCard && targetCard.parentElement) {
            targetCard.style.opacity = "0.45";
          }
        }, settings.autoFadeSeconds * 1000);
      }
    }

    console.log(
      `%c[JA-VI][Đã dịch ${type.toUpperCase()}]%c [${displaySpeaker}]: "${translated_text}" (${ms}ms)`,
      type === "final" ? "color: #34a853; font-weight: bold;" : "color: #81c995;",
      "color: inherit;"
    );
  }

  function trimOldCards() {
    if (!subtitlesBody) return;
    const max = settings.maxCards || 150;
    while (subtitlesBody.children.length > max) {
      const firstChild = subtitlesBody.firstElementChild;
      if (firstChild) {
        firstChild.remove();
      } else {
        break;
      }
    }
  }

  /**
   * Thiết lập bộ lắng nghe sự kiện sao chép bản dịch (Event Delegation)
   * Tự động phản hồi biểu tượng tích xanh ✓ trong 1.5 giây
   */
  function setupCopyButtonListener() {
    if (!subtitlesBody) return;

    subtitlesBody.addEventListener("click", async (e) => {
      const copyBtn = e.target.closest(".card-copy-btn");
      if (!copyBtn) return;
      e.stopPropagation();

      const card = copyBtn.closest(".subtitle-card");
      if (!card) return;

      const transEl = card.querySelector(".translated-text");
      const textToCopy = transEl ? transEl.textContent.trim() : "";
      if (!textToCopy || textToCopy === "..." || textToCopy.includes("Đang dịch...")) return;

      try {
        await navigator.clipboard.writeText(textToCopy);
        copyBtn.classList.add("copied");
        copyBtn.textContent = "✓";
        copyBtn.title = "Đã sao chép!";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.textContent = "📋";
          copyBtn.title = "Sao chép bản dịch";
        }, 1500);
      } catch (err) {
        const textarea = document.createElement("textarea");
        textarea.value = textToCopy;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
          copyBtn.classList.add("copied");
          copyBtn.textContent = "✓";
          setTimeout(() => {
            copyBtn.classList.remove("copied");
            copyBtn.textContent = "📋";
          }, 1500);
        } catch (e2) {}
        document.body.removeChild(textarea);
      }
    });
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
          <div class="voice-wave" id="voice-wave" title="Đang nhận diện giọng nói">
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
          </div>
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
          <div class="translated-row">
            <div class="translated-text" style="font-size: 13px; color: #a8dab5;">
              Đã sẵn sàng. Hãy bật phụ đề tiếng Nhật (CC) trong Google Meet để bắt đầu dịch!
            </div>
            <button class="card-copy-btn" title="Sao chép bản dịch" type="button">📋</button>
          </div>
        </div>
      </div>
      <div class="resize-handle" title="Kéo để thay đổi kích thước"></div>
    `;

    shadowRoot.appendChild(overlayContainer);

    subtitlesBody = shadowRoot.getElementById("subtitles-stream");
    statusDot = shadowRoot.getElementById("status-indicator");
    voiceWaveEl = shadowRoot.getElementById("voice-wave");
    btnModeToggle = shadowRoot.getElementById("btn-mode-toggle");
    btnServerPower = shadowRoot.getElementById("btn-server-power");

    setupCopyButtonListener();

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

    // Đồng bộ lại trạng thái kết nối ngay khi các phần tử UI vừa tạo xong
    updateUiConnectionStatus(isConnectedToServer);
    syncServerStatus();
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
  initCaptionWatcher();

  // Định kỳ kiểm tra trạng thái kết nối máy chủ mỗi 5s (hoàn toàn im lặng)
  setInterval(() => {
    syncServerStatus();
  }, 5000);

  // Đồng bộ trạng thái ban đầu ngay sau khi nạp UI
  setTimeout(() => {
    syncServerStatus();
  }, 400);

})();
