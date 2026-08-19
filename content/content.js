// Vocabulary Collector content script
//
// Responsibilities:
//   1. Detect a text selection on the page.
//   2. Show a compact card near the selection with the word/phrase, Vietnamese
//      meaning, other senses, IPA, a pronunciation button, an example, the
//      surrounding sentence translated, dictionary links, and Save/Cancel.
//   3. Ask the background service worker to do lookups, audio, and saving.
//   4. Also listens for a message from the right-click context menu
//      fallback (see background/background.js) for cases where selecting
//      text and getting a bounding rect is unreliable (e.g. PDFs).

(function () {
  const HOST_ID = "vocab-collector-host";
  const MAX_SELECTION_LENGTH = 200;
  const CARD_WIDTH = 252;
  const BLOCK_SELECTOR = "p,li,td,th,dd,dt,blockquote,pre,figcaption,h1,h2,h3,h4,h5,h6,section,article,div";

  const ICONS = {
    speaker:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    book:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    globe:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg>',
    chevron:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  };

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

  function sendRuntimeMessage(message, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("The extension backend did not respond. Reload this webpage and try again."));
      }, timeoutMs);

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

  /**
   * The sentence the selection sits in. Technical writing reuses the same word
   * across very different senses ("commit", "socket", "port"), so the sentence
   * is what lets the card show how the word is being used *here*.
   */
  function getContextSentence(text) {
    const selection = window.getSelection();
    const node = selection && selection.anchorNode;
    if (!node) return "";

    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const block = element && element.closest ? element.closest(BLOCK_SELECTOR) || element : element;
    if (!block) return "";

    const full = String(block.innerText || block.textContent || "").replace(/\s+/g, " ").trim();
    if (!full || full.length > 1500) return "";

    const index = full.indexOf(text);
    if (index === -1) return "";

    const before = full.slice(0, index);
    const startMatch = before.match(/[.!?:;]\s+[^.!?:;]*$/);
    const start = startMatch ? before.length - startMatch[0].length + startMatch[0].search(/\s+/) : 0;

    const afterIndex = index + text.length;
    const endMatch = full.slice(afterIndex).match(/[.!?]\s|[.!?]$/);
    const end = endMatch ? afterIndex + endMatch.index + 1 : full.length;

    return full.slice(start, end).trim().slice(0, 400);
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

  function createPopup(rawText, anchorX, anchorY, contextSentence) {
    removeExistingPopup();

    const text = rawText.trim();
    const estimatedCardHeight = 190;
    const pos = positionWithinViewport(anchorX, anchorY, CARD_WIDTH, estimatedCardHeight);
    const lookupState = {
      text,
      normalized: text.toLowerCase(),
      meaning: "",
      generalMeaning: "",
      alternatives: [],
      ipa: "",
      dictionaryText: "",
      audioUrl: "",
      example: "",
      contextSentence: "",
      contextMeaning: "",
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
          --vc-bg: #ffffff;
          --vc-fg: #16181d;
          --vc-muted: #8b8f98;
          --vc-soft: #5b606b;
          --vc-line: rgba(0,0,0,0.07);
          --vc-hover: rgba(0,0,0,0.045);
          --vc-accent: #c98a2c;
          --vc-accent-fg: #ffffff;
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 12px;
          background: var(--vc-bg);
          color: var(--vc-fg);
          border: 1px solid var(--vc-line);
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 10px 28px -6px rgba(0,0,0,0.22);
          padding: 9px 10px 8px;
          width: ${CARD_WIDTH}px;
          line-height: 1.45;
          animation: vc-in 130ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @media (prefers-color-scheme: dark) {
          .vc-card {
            --vc-bg: #1c1d21;
            --vc-fg: #ecedf0;
            --vc-muted: #8a8e97;
            --vc-soft: #b3b7c0;
            --vc-line: rgba(255,255,255,0.10);
            --vc-hover: rgba(255,255,255,0.07);
            --vc-accent: #d9a04a;
            --vc-accent-fg: #1c1d21;
            box-shadow: 0 10px 30px -6px rgba(0,0,0,0.6);
          }
        }
        @keyframes vc-in { from { opacity: 0; transform: translateY(-3px) scale(0.985); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .vc-card { animation: none; } }

        .vc-head { display: flex; align-items: baseline; gap: 6px; }
        .vc-word {
          font-size: 13.5px; font-weight: 650; letter-spacing: -0.01em;
          word-break: break-word; min-width: 0; flex: 1;
        }
        .vc-ipa { font-size: 11px; color: var(--vc-muted); white-space: nowrap; font-variant: none; }
        .vc-speak {
          flex: none; align-self: center; margin-left: 1px;
          width: 24px; height: 24px; padding: 4px;
          border: 0; border-radius: 6px; background: transparent; color: var(--vc-soft);
          cursor: pointer; display: grid; place-items: center;
        }
        .vc-speak svg { width: 100%; height: 100%; }
        .vc-speak:hover { background: var(--vc-hover); color: var(--vc-fg); }
        .vc-speak.is-busy { color: var(--vc-accent); animation: vc-pulse 900ms ease-in-out infinite; }
        @keyframes vc-pulse { 50% { opacity: 0.45; } }

        .vc-meaning {
          margin-top: 3px; font-size: 13px; color: var(--vc-fg);
          word-break: break-word; min-height: 17px;
        }
        .vc-tag {
          display: inline-block; margin-right: 5px; padding: 0 5px;
          border-radius: 4px; background: var(--vc-accent); color: var(--vc-accent-fg);
          font-size: 9px; font-weight: 700; letter-spacing: 0.04em; vertical-align: 1.5px;
        }
        .vc-senses, .vc-general, .vc-example {
          margin-top: 3px; font-size: 11px; color: var(--vc-soft);
          display: none; word-break: break-word;
        }
        .vc-senses b { font-weight: 600; color: var(--vc-muted); }
        /* display is set to -webkit-box by setLine() only when there is an
           example to show, so the clamp does not reserve space when empty. */
        .vc-example { font-style: italic; color: var(--vc-muted);
          -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .vc-error { color: #c2410c; }

        .vc-context { margin-top: 5px; display: none; }
        .vc-context-toggle {
          display: flex; align-items: center; gap: 3px; width: 100%; padding: 0;
          border: 0; background: none; color: var(--vc-muted);
          font: inherit; font-size: 10.5px; cursor: pointer; text-align: left;
        }
        .vc-context-toggle:hover { color: var(--vc-fg); }
        .vc-context-toggle svg { width: 11px; height: 11px; transition: transform 120ms ease; }
        .vc-context.is-open .vc-context-toggle svg { transform: rotate(180deg); }
        .vc-context-body {
          display: none; margin-top: 4px; padding-left: 7px;
          border-left: 2px solid var(--vc-line); font-size: 11px; color: var(--vc-soft);
        }
        .vc-context.is-open .vc-context-body { display: block; }
        .vc-context-src { color: var(--vc-muted); font-style: italic; margin-bottom: 2px; }

        .vc-spinner {
          display: inline-block; width: 9px; height: 9px; margin-right: 5px;
          border: 1.5px solid var(--vc-line); border-top-color: var(--vc-accent);
          border-radius: 50%; animation: vc-spin 700ms linear infinite; vertical-align: middle;
        }
        @keyframes vc-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .vc-spinner { animation: none; } }

        .vc-actions {
          display: flex; align-items: center; gap: 4px;
          margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--vc-line);
        }
        .vc-spacer { flex: 1; }
        .vc-icon-btn {
          width: 24px; height: 24px; padding: 5px; border: 0; border-radius: 6px;
          background: transparent; color: var(--vc-muted); cursor: pointer; display: grid; place-items: center;
        }
        .vc-icon-btn svg { width: 100%; height: 100%; }
        .vc-icon-btn:hover { background: var(--vc-hover); color: var(--vc-fg); }
        .vc-btn {
          border: 0; border-radius: 7px; padding: 4px 10px;
          font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
        }
        .vc-btn-ghost { background: transparent; color: var(--vc-muted); }
        .vc-btn-ghost:hover { background: var(--vc-hover); color: var(--vc-fg); }
        .vc-btn-primary { background: var(--vc-accent); color: var(--vc-accent-fg); }
        .vc-btn-primary:hover { filter: brightness(1.06); }
        .vc-btn-primary:disabled { opacity: 0.55; cursor: default; filter: none; }
        .vc-btn:focus-visible, .vc-icon-btn:focus-visible, .vc-speak:focus-visible,
        .vc-context-toggle:focus-visible { outline: 2px solid var(--vc-accent); outline-offset: 2px; }
        .vc-status { margin-top: 5px; font-size: 10px; color: var(--vc-muted); }
        .vc-status:empty { display: none; }
      </style>
      <div class="vc-card" role="dialog" aria-label="Vocabulary Collector">
        <div class="vc-head">
          <div class="vc-word" data-role="word">${escapeHtml(text)}</div>
          <div class="vc-ipa" data-role="ipa"></div>
          <button class="vc-speak" data-role="speak" title="Listen" aria-label="Listen to pronunciation">${ICONS.speaker}</button>
        </div>
        <div class="vc-meaning" data-role="meaning"><span class="vc-spinner"></span>Đang tra nghĩa…</div>
        <div class="vc-senses" data-role="senses"></div>
        <div class="vc-general" data-role="general"></div>
        <div class="vc-example" data-role="example"></div>
        <div class="vc-context" data-role="context">
          <button class="vc-context-toggle" data-role="context-toggle">${ICONS.chevron}<span>In context</span></button>
          <div class="vc-context-body">
            <div class="vc-context-src" data-role="context-src"></div>
            <div data-role="context-meaning"></div>
          </div>
        </div>
        <div class="vc-actions">
          <button class="vc-icon-btn" data-role="cambridge" title="Open in Cambridge Dictionary">${ICONS.book}</button>
          <button class="vc-icon-btn" data-role="wiktionary" title="Open in Wiktionary (ad-free)">${ICONS.globe}</button>
          <div class="vc-spacer"></div>
          <button class="vc-btn vc-btn-ghost" data-role="cancel">Cancel</button>
          <button class="vc-btn vc-btn-primary" data-role="save">Save</button>
        </div>
        <div class="vc-status" data-role="status"></div>
      </div>
    `;

    root.querySelector('[data-role="cambridge"]').addEventListener("click", () => {
      window.open(lookupState.cambridgeUrl || buildCambridgeUrl(text), "_blank", "noopener");
    });
    root.querySelector('[data-role="wiktionary"]').addEventListener("click", () => {
      window.open(buildWiktionaryUrl(text), "_blank", "noopener");
    });
    root.querySelector('[data-role="cancel"]').addEventListener("click", removeExistingPopup);
    root.querySelector('[data-role="save"]').addEventListener("click", (event) =>
      handleSave(lookupState, root, event.currentTarget)
    );
    root.querySelector('[data-role="speak"]').addEventListener("click", (event) =>
      handleSpeak(lookupState, root, event.currentTarget)
    );
    root.querySelector('[data-role="context-toggle"]').addEventListener("click", () => {
      root.querySelector('[data-role="context"]').classList.toggle("is-open");
    });

    lookupVocabulary(text, contextSentence, root, lookupState);
  }

  async function lookupVocabulary(text, contextSentence, root, lookupState) {
    const meaningEl = root.querySelector('[data-role="meaning"]');
    const statusEl = root.querySelector('[data-role="status"]');

    try {
      const data = await sendRuntimeMessage({
        type: "VC_LOOKUP_TEXT",
        text,
        context: contextSentence || "",
      });
      Object.assign(lookupState, data);

      meaningEl.classList.toggle("vc-error", !data.meaning);
      meaningEl.innerHTML = data.meaning
        ? `${data.isGlossary ? '<span class="vc-tag">IT</span>' : ""}${escapeHtml(data.meaning)}`
        : "No Vietnamese meaning found.";

      renderSenses(root, data);
      setLine(root, "general", data.generalMeaning ? `Nghĩa thường: ${data.generalMeaning}` : "");
      setLine(root, "example", data.example ? `“${data.example}”` : "");
      renderIpa(root, data);
      renderContext(root, data);

      statusEl.textContent = data.meaning ? "" : (data.errors || []).join(" ");
      root.querySelector('[data-role="word"]').title = [data.translationProvider, data.ipaProvider]
        .filter(Boolean)
        .join(" + ");
    } catch (error) {
      meaningEl.classList.add("vc-error");
      meaningEl.textContent = error.message.includes("Reload")
        ? error.message
        : "Lookup failed. You can still save the word.";
      statusEl.textContent = error.message;
    }
  }

  function setLine(root, role, value) {
    const el = root.querySelector(`[data-role="${role}"]`);
    if (!el) return;
    el.textContent = value || "";
    el.style.display = value ? "block" : "none";
    if (role === "example" && value) el.style.display = "-webkit-box";
  }

  function renderSenses(root, data) {
    const el = root.querySelector('[data-role="senses"]');
    const groups = Array.isArray(data.alternatives) ? data.alternatives : [];
    if (!groups.length) {
      el.style.display = "none";
      return;
    }

    el.innerHTML = groups
      .map((group) => {
        const label = group.partOfSpeech ? `<b>${escapeHtml(group.partOfSpeech)}:</b> ` : "";
        return `${label}${escapeHtml(group.terms.join(", "))}`;
      })
      .join(" · ");
    el.style.display = "block";
  }

  function renderIpa(root, data) {
    const el = root.querySelector('[data-role="ipa"]');
    if (!data.ipa) {
      el.textContent = "";
      return;
    }

    const lookupWord = String(data.dictionaryText || "").trim();
    const differs = lookupWord && lookupWord.toLowerCase() !== String(data.text || "").toLowerCase();
    el.textContent = data.ipa;
    el.title = differs ? `IPA của "${lookupWord}"` : "IPA";
  }

  function renderContext(root, data) {
    const wrap = root.querySelector('[data-role="context"]');
    if (!data.contextMeaning || !data.contextSentence) {
      wrap.style.display = "none";
      return;
    }

    root.querySelector('[data-role="context-src"]').textContent = data.contextSentence;
    root.querySelector('[data-role="context-meaning"]').textContent = data.contextMeaning;
    wrap.style.display = "block";
  }

  async function handleSpeak(lookupState, root, button) {
    if (button.classList.contains("is-busy")) return;
    button.classList.add("is-busy");
    const statusEl = root.querySelector('[data-role="status"]');

    try {
      await sendRuntimeMessage({
        type: "VC_SPEAK",
        text: lookupState.dictionaryText || lookupState.text,
        audioUrl: lookupState.audioUrl,
        lang: "en",
      });
      statusEl.textContent = "";
    } catch (error) {
      // The offscreen route can be unavailable (older Chrome, locked-down
      // profiles); the page's own speech synthesis is a reasonable last resort.
      if (!speakInPage(lookupState.dictionaryText || lookupState.text)) {
        statusEl.textContent = error.message;
      }
    } finally {
      window.setTimeout(() => button.classList.remove("is-busy"), 400);
    }
  }

  function speakInPage(text) {
    if (!text || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.95;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      return false;
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
          generalMeaning: lookupState.generalMeaning,
          ipa: lookupState.ipa,
          dictionaryText: lookupState.dictionaryText,
          audioUrl: lookupState.audioUrl,
          example: lookupState.example,
          contextSentence: lookupState.contextSentence,
          contextMeaning: lookupState.contextMeaning,
          cambridgeUrl: lookupState.cambridgeUrl || buildCambridgeUrl(lookupState.text),
          translationProvider: lookupState.translationProvider,
          ipaProvider: lookupState.ipaProvider,
        },
      });

      if (result.status === "duplicate") {
        saveBtn.textContent = "Already saved";
        statusEl.textContent = "This word is already in your list.";
        return;
      }

      saveBtn.textContent = result.status === "saved_remote" ? "Saved + synced" : "Saved";
      if (result.item && result.item.syncError) {
        statusEl.textContent = `Saved locally. Sync error: ${result.item.syncError}`;
      }
      window.setTimeout(removeExistingPopup, 900);
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      statusEl.textContent = error.message;
    }
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
      const context = getContextSentence(text);
      const x = rect.left + window.scrollX;
      const y = rect.bottom + window.scrollY + 8;
      createPopup(text, x, y, context);
    }, 0);
  });

  document.addEventListener("mousedown", (event) => {
    if (isInsideOurUi(event)) return;
    removeExistingPopup();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") removeExistingPopup();
  });

  window.addEventListener("scroll", removeExistingPopup, { passive: true });

  // Fallback path from the right-click context menu (background.js), used
  // when we can't reliably read a selection rect (e.g. some PDF viewers).
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "VC_SHOW_POPUP_FOR_TEXT" && message.text) {
      const x = window.scrollX + Math.max(20, window.innerWidth / 2 - CARD_WIDTH / 2);
      const y = window.scrollY + 80;
      createPopup(message.text, x, y, getContextSentence(message.text));
    }
  });
})();
