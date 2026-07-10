// Vocabulary Collector content script
//
// Responsibilities:
//   1. Detect a text selection on the page.
//   2. Show a small popup card near the selection with the word/phrase,
//      Vietnamese meaning, IPA, example, dictionary links, and Save/Cancel.
//   3. Ask the background service worker to do lookups and save the word.
//   4. Also listens for a message from the right-click context menu
//      fallback (see background/background.js) for cases where selecting
//      text and getting a bounding rect is unreliable (e.g. PDFs).

(function () {
  const HOST_ID = "vocab-collector-host";
  const MAX_SELECTION_LENGTH = 200;

  /** Returns true if the event originated from inside our own popup UI. */
  function isInsideOurUi(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some((el) => el && el.id === HOST_ID);
  }

  function removeExistingPopup() {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("The extension backend did not respond. Reload this webpage and try again."));
      }, 12000);

      chrome.runtime.sendMessage(message, (response) => {
        window.clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(formatRuntimeError(lastError.message)));
          return;
        }

        if (!response || response.ok === false) {
          reject(new Error((response && response.error) || "The extension backend did not respond."));
          return;
        }

        resolve(response.data);
      });
    });
  }

  function formatRuntimeError(message) {
    if (/extension context invalidated/i.test(message)) {
      return "The extension was reloaded. Reload this webpage, then select the word again.";
    }
    if (/receiving end does not exist/i.test(message)) {
      return "The extension backend is not available on this page. Reload the extension and this webpage.";
    }
    return message || "The extension backend did not respond.";
  }

  /** Best-effort Cambridge Dictionary URL. Falls back to search results
   *  for multi-word phrases or anything we're not confident has a direct
   *  page, rather than guessing a URL that might 404. */
  function buildCambridgeUrl(rawText) {
    const text = rawText.trim();
    const isSingleWord = !/\s/.test(text) && text.length <= 40;
    if (isSingleWord) {
      return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(text.toLowerCase())}`;
    }
    return `https://dictionary.cambridge.org/search/english/direct/?q=${encodeURIComponent(text)}`;
  }

  /** Best-effort Wiktionary URL (ad-free alternative). */
  function buildWiktionaryUrl(rawText) {
    const text = rawText.trim();
    const slug = text.replace(/\s+/g, "_");
    return `https://en.wiktionary.org/wiki/${encodeURIComponent(slug)}`;
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  }

  function positionWithinViewport(x, y, cardWidth, cardHeight) {
    const margin = 8;
    const maxX = window.scrollX + document.documentElement.clientWidth - cardWidth - margin;
    const maxY = window.scrollY + document.documentElement.clientHeight - cardHeight - margin;
    return {
      x: Math.max(window.scrollX + margin, Math.min(x, maxX)),
      y: Math.max(window.scrollY + margin, Math.min(y, maxY)),
    };
  }

  function createPopup(rawText, anchorX, anchorY) {
    removeExistingPopup();

    const text = rawText.trim();
    const cardWidth = 280;
    const estimatedCardHeight = 210;
    const pos = positionWithinViewport(anchorX, anchorY, cardWidth, estimatedCardHeight);
    const lookupState = {
      text,
      normalized: text.toLowerCase(),
      meaning: "",
      ipa: "",
      dictionaryText: "",
      audioUrl: "",
      example: "",
      cambridgeUrl: buildCambridgeUrl(text),
      translationProvider: "",
      ipaProvider: "",
    };

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "absolute";
    host.style.top = `${pos.y}px`;
    host.style.left = `${pos.x}px`;
    host.style.zIndex = "2147483647";
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .vc-card {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #ffffff;
          color: #1f2937;
          border: 1px solid #e5e7eb;
          border-left: 3px solid #c98a2c;
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.08);
          padding: 12px 14px;
          width: ${cardWidth}px;
          line-height: 1.4;
          animation: vc-pop-in 120ms ease-out;
        }
        @keyframes vc-pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .vc-card { animation: none; } }
        .vc-word { font-size: 15px; font-weight: 700; margin-bottom: 4px; word-break: break-word; }
        .vc-meaning { font-size: 13px; color: #374151; margin-bottom: 2px; min-height: 18px; }
        .vc-ipa { font-size: 12px; color: #6b7280; font-style: italic; margin-bottom: 4px; min-height: 16px; }
        .vc-example { font-size: 12px; color: #4b5563; margin-bottom: 10px; display: none; }
        .vc-error { color: #b45309; }
        .vc-spinner {
          display: inline-block; width: 10px; height: 10px;
          border: 2px solid #d1d5db; border-top-color: #c98a2c; border-radius: 50%;
          animation: vc-spin 700ms linear infinite; margin-right: 6px; vertical-align: middle;
        }
        @keyframes vc-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .vc-spinner { animation: none; } }
        .vc-actions { display: flex; align-items: center; gap: 6px; }
        .vc-spacer { flex: 1; }
        .vc-icon-btn {
          border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 8px;
          width: 30px; height: 30px; font-size: 14px; cursor: pointer;
        }
        .vc-icon-btn:hover { background: #f3f4f6; }
        .vc-btn { border: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .vc-btn-ghost { background: transparent; color: #6b7280; }
        .vc-btn-ghost:hover { background: #f3f4f6; }
        .vc-btn-primary { background: #c98a2c; color: #ffffff; }
        .vc-btn-primary:hover { background: #b3791f; }
        .vc-btn-primary:disabled { opacity: 0.6; cursor: default; }
        .vc-btn:focus-visible, .vc-icon-btn:focus-visible { outline: 2px solid #c98a2c; outline-offset: 2px; }
        .vc-footnote { margin-top: 8px; font-size: 10px; color: #9ca3af; }
      </style>
      <div class="vc-card" role="dialog" aria-label="Vocabulary Collector">
        <div class="vc-word">${escapeHtml(text)}</div>
        <div class="vc-meaning" data-role="meaning"><span class="vc-spinner"></span>Đang tra nghĩa…</div>
        <div class="vc-ipa" data-role="ipa"></div>
        <div class="vc-example" data-role="example"></div>
        <div class="vc-actions">
          <button class="vc-icon-btn" data-role="cambridge" title="Open in Cambridge Dictionary">📘</button>
          <button class="vc-icon-btn" data-role="wiktionary" title="Open in Wiktionary (ad-free)">📖</button>
          <div class="vc-spacer"></div>
          <button class="vc-btn vc-btn-ghost" data-role="cancel">Cancel</button>
          <button class="vc-btn vc-btn-primary" data-role="save">Save</button>
        </div>
        <div class="vc-footnote" data-role="status">Looking up Vietnamese meaning, IPA, and example…</div>
      </div>
    `;

    root.querySelector('[data-role="cambridge"]').addEventListener("click", () => {
      window.open(lookupState.cambridgeUrl || buildCambridgeUrl(text), "_blank", "noopener");
    });
    root.querySelector('[data-role="wiktionary"]').addEventListener("click", () => {
      window.open(buildWiktionaryUrl(text), "_blank", "noopener");
    });
    root.querySelector('[data-role="cancel"]').addEventListener("click", removeExistingPopup);
    root.querySelector('[data-role="save"]').addEventListener("click", (e) =>
      handleSave(lookupState, root, e.currentTarget)
    );

    lookupVocabulary(text, root, lookupState);
  }

  async function lookupVocabulary(text, root, lookupState) {
    const meaningEl = root.querySelector('[data-role="meaning"]');
    const ipaEl = root.querySelector('[data-role="ipa"]');
    const exampleEl = root.querySelector('[data-role="example"]');
    const statusEl = root.querySelector('[data-role="status"]');

    try {
      const data = await sendRuntimeMessage({ type: "VC_LOOKUP_TEXT", text });
      Object.assign(lookupState, data);

      if (meaningEl) {
        meaningEl.classList.toggle("vc-error", !data.meaning);
        meaningEl.textContent = data.meaning || "No Vietnamese meaning found.";
      }
      if (ipaEl) {
        ipaEl.textContent = formatIpaText(data);
      }
      if (exampleEl) {
        exampleEl.style.display = data.example ? "block" : "none";
        exampleEl.textContent = data.example ? `Example: ${data.example}` : "";
      }
      if (statusEl) {
        const providers = [data.translationProvider, data.ipaProvider].filter(Boolean).join(" + ");
        statusEl.textContent = providers ? `Lookup: ${providers}` : data.errors.join(" ");
      }
    } catch (error) {
      if (meaningEl) {
        meaningEl.classList.add("vc-error");
        meaningEl.textContent = error.message.includes("Reload")
          ? error.message
          : "Lookup failed. You can still save the word.";
      }
      if (ipaEl) ipaEl.textContent = "";
      if (exampleEl) {
        exampleEl.style.display = "none";
        exampleEl.textContent = "";
      }
      if (statusEl) statusEl.textContent = error.message;
    }
  }

  async function handleSave(lookupState, root, saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const statusEl = root.querySelector('[data-role="status"]');

    try {
      const result = await sendRuntimeMessage({
        type: "VC_SAVE_WORD",
        item: {
          text: lookupState.text,
          meaning: lookupState.meaning,
          ipa: lookupState.ipa,
          dictionaryText: lookupState.dictionaryText,
          audioUrl: lookupState.audioUrl,
          example: lookupState.example,
          cambridgeUrl: lookupState.cambridgeUrl || buildCambridgeUrl(lookupState.text),
          translationProvider: lookupState.translationProvider,
          ipaProvider: lookupState.ipaProvider,
        },
      });

      if (result.status === "duplicate") {
        saveBtn.textContent = "Already saved";
        if (statusEl) statusEl.textContent = "This word is already in your list.";
        return;
      }

      saveBtn.textContent = result.message || "Saved";
      if (statusEl && result.item && result.item.syncError) {
        statusEl.textContent = `Saved locally. Sync error: ${result.item.syncError}`;
      }
      window.setTimeout(removeExistingPopup, 900);
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      if (statusEl) statusEl.textContent = error.message;
    }
  }

  function formatIpaText(data) {
    if (!data.ipa) return data.isPhrase ? "" : "IPA: not found";

    const lookupWord = String(data.dictionaryText || "").trim();
    if (lookupWord && lookupWord.toLowerCase() !== String(data.text || "").toLowerCase()) {
      return `IPA (${lookupWord}): ${data.ipa}`;
    }

    return `IPA: ${data.ipa}`;
  }

  document.addEventListener("mouseup", (event) => {
    if (isInsideOurUi(event)) return;
    // Defer one tick so window.getSelection() reflects the just-finished drag.
    window.setTimeout(() => {
      const text = window.getSelection().toString().trim();
      if (!text || text.length > MAX_SELECTION_LENGTH) {
        return;
      }
      const rect = getSelectionRect();
      if (!rect) return;
      const x = rect.left + window.scrollX;
      const y = rect.bottom + window.scrollY + 8;
      createPopup(text, x, y);
    }, 0);
  });

  document.addEventListener("mousedown", (event) => {
    if (isInsideOurUi(event)) return;
    removeExistingPopup();
  });

  window.addEventListener("scroll", removeExistingPopup, { passive: true });

  // Fallback path from the right-click context menu (background.js), used
  // when we can't reliably read a selection rect (e.g. some PDF viewers).
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "VC_SHOW_POPUP_FOR_TEXT" && message.text) {
      const x = window.scrollX + Math.max(20, window.innerWidth / 2 - 140);
      const y = window.scrollY + 80;
      createPopup(message.text, x, y);
    }
  });
})();
