// Vocabulary Collector background service worker
//
// Handles the extension-side "backend" work:
//   1. Context-menu fallback for selected text.
//   2. Vietnamese lookup via DeepL when configured, otherwise MyMemory.
//   3. Dictionary details via Free Dictionary API for single English words.
//   4. Save locally, with optional Google Sheets sync through an Apps Script URL.

const CONTEXT_MENU_ID = "vocab-collector-save-selection";
const MAX_SELECTION_LENGTH = 200;

const DEFAULT_SETTINGS = {
  deeplApiKey: "",
  deeplEndpoint: "https://api-free.deepl.com/v2/translate",
  myMemoryEmail: "",
  saveRemoteEnabled: false,
  sheetsWebhookUrl: "",
  sheetsWebhookToken: "",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Add "%s" to Vocabulary Collector',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  if (!info.selectionText || !tab || tab.id === undefined) return;

  chrome.tabs.sendMessage(tab.id, {
    type: "VC_SHOW_POPUP_FOR_TEXT",
    text: sanitizeSelection(info.selectionText),
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "VC_LOOKUP_TEXT") {
    lookupVocabulary(message.text)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "VC_SAVE_WORD") {
    saveVocabulary(message.item)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "VC_TEST_SHEETS_SYNC") {
    testSheetsSync()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "VC_TEST_LOOKUP") {
    lookupVocabulary("salient")
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "VC_SYNC_ALL_LOCAL") {
    syncAllLocalVocabulary()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  return false;
});

function sanitizeSelection(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_SELECTION_LENGTH);
}

function isSingleWord(text) {
  return /^[A-Za-z][A-Za-z'-]{0,39}$/.test(text);
}

function normalizeText(text) {
  return sanitizeSelection(text).toLocaleLowerCase();
}

function buildCambridgeUrl(rawText) {
  const text = sanitizeSelection(rawText);
  const isSingle = isSingleWord(text);
  if (isSingle) {
    return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(text.toLowerCase())}`;
  }
  return `https://dictionary.cambridge.org/search/english/direct/?q=${encodeURIComponent(text)}`;
}

function createItemId(normalized) {
  const safeText = normalized.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
  return `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeText}`;
}

function ensureItemId(item) {
  if (item.id) return item.id;
  item.id = createItemId(item.normalized || normalizeText(item.text));
  return item.id;
}

function toUserError(error) {
  if (error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, resolve);
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function getSettings() {
  const data = await storageGet({ vcSettings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...(data.vcSettings || {}) };
}

async function lookupVocabulary(rawText) {
  const text = sanitizeSelection(rawText);
  if (!text) throw new Error("Select a word or phrase first.");

  const settings = await getSettings();
  const singleWord = isSingleWord(text);
  const dictionaryPromise = singleWord ? lookupDictionaryDetails(text) : Promise.resolve(null);
  const translationPromise = translateToVietnamese(text, settings);
  const [translation, dictionary] = await Promise.allSettled([translationPromise, dictionaryPromise]);

  const translationData = translation.status === "fulfilled" ? translation.value : null;
  const dictionaryData = dictionary.status === "fulfilled" ? dictionary.value : null;
  const errors = [];

  if (translation.status === "rejected") errors.push(toUserError(translation.reason));
  if (dictionary.status === "rejected" && singleWord) errors.push(toUserError(dictionary.reason));

  return {
    text,
    normalized: normalizeText(text),
    meaning: translationData ? translationData.meaning : "",
    translationProvider: translationData ? translationData.provider : "",
    ipa: dictionaryData ? dictionaryData.ipa : "",
    audioUrl: dictionaryData ? dictionaryData.audioUrl : "",
    example: dictionaryData ? dictionaryData.example : "",
    cambridgeUrl: buildCambridgeUrl(text),
    ipaProvider: dictionaryData ? dictionaryData.provider : "",
    isPhrase: !singleWord,
    errors,
  };
}

async function translateToVietnamese(text, settings) {
  if (settings.deeplApiKey) {
    try {
      return await translateWithDeepL(text, settings);
    } catch (error) {
      console.warn("DeepL lookup failed, falling back to MyMemory.", error);
    }
  }

  return translateWithMyMemory(text, settings);
}

async function translateWithDeepL(text, settings) {
  const body = new URLSearchParams({
    text,
    source_lang: "EN",
    target_lang: "VI",
  });

  const response = await fetch(settings.deeplEndpoint || DEFAULT_SETTINGS.deeplEndpoint, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${settings.deeplApiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) throw new Error(`DeepL lookup failed (${response.status}).`);

  const data = await response.json();
  const meaning = data && data.translations && data.translations[0] && data.translations[0].text;
  if (!meaning) throw new Error("DeepL returned no translation.");

  return { meaning, provider: "DeepL" };
}

async function translateWithMyMemory(text, settings) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|vi");
  if (settings.myMemoryEmail) url.searchParams.set("de", settings.myMemoryEmail);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`MyMemory lookup failed (${response.status}).`);

  const data = await response.json();
  const meaning = data && data.responseData && data.responseData.translatedText;
  if (!meaning) throw new Error("No Vietnamese meaning found.");

  return { meaning, provider: "MyMemory" };
}

async function lookupDictionaryDetails(word) {
  const response = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`
  );

  if (!response.ok) throw new Error("No dictionary details found for this word.");

  const data = await response.json();
  const entries = Array.isArray(data) ? data : [];
  const phonetics = entries.flatMap((entry) => entry.phonetics || []);
  const phonetic =
    phonetics.find((item) => item.text && item.text.trim()) ||
    entries.find((entry) => entry.phonetic && entry.phonetic.trim());
  const ipa = (phonetic && (phonetic.text || phonetic.phonetic)) || "";
  const audio = phonetics.find((item) => item.audio && item.audio.trim());
  const definitions = entries.flatMap((entry) =>
    (entry.meanings || []).flatMap((meaning) => meaning.definitions || [])
  );
  const example = definitions.find((definition) => definition.example && definition.example.trim());

  if (!ipa && !audio && !example) throw new Error("No dictionary details found for this word.");
  return {
    ipa,
    audioUrl: normalizeAudioUrl(audio && audio.audio),
    example: example ? example.example : "",
    provider: "Free Dictionary API",
  };
}

function normalizeAudioUrl(value) {
  const audioUrl = String(value || "").trim();
  if (!audioUrl) return "";
  return sanitizeHttpUrl(audioUrl.startsWith("//") ? `https:${audioUrl}` : audioUrl);
}

async function saveVocabulary(rawItem) {
  const sourceItem = rawItem || {};
  const text = sanitizeSelection(sourceItem.text);
  if (!text) throw new Error("Nothing to save.");

  const normalized = normalizeText(text);
  const data = await storageGet({ savedWords: [] });
  const savedWords = Array.isArray(data.savedWords) ? data.savedWords : [];

  if (savedWords.some((word) => word.normalized === normalized)) {
    return { status: "duplicate", message: "Already saved" };
  }

  const settings = await getSettings();
  const item = {
    id: createItemId(normalized),
    text,
    normalized,
    meaning: sanitizeOptional(sourceItem.meaning),
    ipa: sanitizeOptional(sourceItem.ipa),
    audioUrl: sanitizeOptional(sourceItem.audioUrl),
    example: sanitizeOptional(sourceItem.example),
    cambridgeUrl: sanitizeOptional(sourceItem.cambridgeUrl) || buildCambridgeUrl(text),
    translationProvider: sanitizeOptional(sourceItem.translationProvider),
    ipaProvider: sanitizeOptional(sourceItem.ipaProvider),
    createdAt: new Date().toISOString(),
    synced: false,
    syncError: "",
  };

  if (settings.saveRemoteEnabled && settings.sheetsWebhookUrl) {
    try {
      await appendToSheet(settings.sheetsWebhookUrl, settings.sheetsWebhookToken, item);
      item.synced = true;
    } catch (error) {
      item.syncError = toUserError(error);
    }
  }

  await storageSet({ savedWords: [item, ...savedWords] });

  if (item.synced) return { status: "saved_remote", item, message: "Saved + synced" };
  if (item.syncError) return { status: "saved_local_sync_failed", item, message: "Saved locally" };
  return { status: "saved_local", item, message: "Saved locally" };
}

async function testSheetsSync() {
  const settings = await getSettings();
  if (!settings.saveRemoteEnabled) {
    throw new Error("Turn on Google Sheets sync first.");
  }
  if (!settings.sheetsWebhookUrl) {
    throw new Error("Paste your Apps Script Web App URL first.");
  }
  if (!settings.sheetsWebhookToken) {
    throw new Error("Add a webhook secret before testing Google Sheets sync.");
  }

  await appendToSheet(settings.sheetsWebhookUrl, settings.sheetsWebhookToken, {
    id: "__sync_test__",
    text: "__sync_test__",
    normalized: "__sync_test__",
    meaning: "Vocabulary Collector settings test",
    ipa: "",
    audioUrl: "",
    example: "Settings test row from Vocabulary Collector",
    cambridgeUrl: buildCambridgeUrl("__sync_test__"),
    createdAt: new Date().toISOString(),
    translationProvider: "Manual test",
    ipaProvider: "",
  });

  return { message: "Test row sent. Check your Google Sheet." };
}

async function syncAllLocalVocabulary() {
  const settings = await getSettings();
  if (!settings.saveRemoteEnabled) {
    throw new Error("Turn on Google Sheets sync first.");
  }
  if (!settings.sheetsWebhookUrl) {
    throw new Error("Paste your Apps Script Web App URL first.");
  }
  if (!settings.sheetsWebhookToken) {
    throw new Error("Add a webhook secret before syncing Google Sheets.");
  }

  const data = await storageGet({ savedWords: [] });
  const savedWords = Array.isArray(data.savedWords) ? data.savedWords : [];
  if (!savedWords.length) {
    return { message: "No local words to sync.", syncedCount: 0, failedCount: 0 };
  }

  let syncedCount = 0;
  let failedCount = 0;
  const updatedWords = [];

  for (const word of savedWords) {
    const item = { ...word };
    ensureItemId(item);
    item.normalized = item.normalized || normalizeText(item.text);

    try {
      await appendToSheet(settings.sheetsWebhookUrl, settings.sheetsWebhookToken, item);
      item.synced = true;
      item.syncError = "";
      syncedCount += 1;
    } catch (error) {
      item.synced = false;
      item.syncError = toUserError(error);
      failedCount += 1;
    }

    updatedWords.push(item);
  }

  await storageSet({ savedWords: updatedWords });

  return {
    message: failedCount
      ? `Synced ${syncedCount}; ${failedCount} failed.`
      : `Synced ${syncedCount} local item${syncedCount === 1 ? "" : "s"}.`,
    syncedCount,
    failedCount,
  };
}

function sanitizeOptional(value) {
  return String(value || "").trim().slice(0, 1000);
}

function sanitizeHttpUrl(value) {
  const url = sanitizeOptional(value);
  if (!url) return "";

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch (error) {
    return "";
  }
}

function redactUrlForError(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "script.google.com" && url.pathname.includes("/macros/s/")) {
      return `${url.origin}/macros/s/.../exec`;
    }
    return url.origin;
  } catch (error) {
    return "(unavailable)";
  }
}

async function appendToSheet(webhookUrl, webhookToken, item) {
  if (!webhookToken) throw new Error("Add a webhook secret before syncing Google Sheets.");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      english: item.text,
      vietnameseMeaning: item.meaning,
      ipa: item.ipa,
      audioUrl: sanitizeHttpUrl(item.audioUrl),
      example: item.example || "",
      cambridgeUrl: sanitizeHttpUrl(item.cambridgeUrl || buildCambridgeUrl(item.text)),
      token: webhookToken || "",
    }),
  });

  if (!response.ok) throw new Error(`Google Sheets sync failed (${response.status}).`);

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 140);
    if (/authorization needed/i.test(preview)) {
      throw new Error(
        "Google says Authorization needed. In Apps Script, authorize the project, then redeploy the Web App with Execute as: Me and Access: Anyone."
      );
    }
    throw new Error(
      `Google Sheets sync did not return JSON. Status ${response.status}; endpoint: ${redactUrlForError(response.url)}; preview: ${preview || "(empty response)"}`
    );
  }

  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || "Google Sheets sync failed.");
  }
}
