// Vocabulary Collector background service worker
//
// Handles the extension-side "backend" work:
//   1. Context-menu fallback for selected text.
//   2. Vietnamese lookup: tech glossary -> Google Translate -> DeepL -> MyMemory,
//      with sense alternatives and optional sentence-context translation.
//   3. Dictionary details via Free Dictionary API for single English words.
//   4. Pronunciation audio playback through an offscreen document.
//   5. Save locally, with optional Google Sheets sync through an Apps Script URL.

import { TECH_GLOSSARY, AMBIGUOUS_TECH_TERMS } from "./glossary.js";

const CONTEXT_MENU_ID = "vocab-collector-save-selection";
const MAX_SELECTION_LENGTH = 200;
const MAX_CONTEXT_LENGTH = 400;
const OFFSCREEN_PATH = "offscreen/offscreen.html";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  translationProvider: "auto",
  techGlossaryEnabled: true,
  contextTranslationEnabled: true,
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
  // Messages addressed to the offscreen document are not ours to answer.
  if (message.target === "offscreen") return false;

  if (message.type === "VC_LOOKUP_TEXT") {
    lookupVocabulary(message.text, message.context)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "VC_SPEAK") {
    speak(message.text, message.audioUrl, message.lang)
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
    lookupVocabulary("commit", "You should commit your changes before merging the branch.")
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
  return toNfc(sanitizeSelection(text)).toLocaleLowerCase();
}

/**
 * Google Translate returns its dictionary senses with decomposed Vietnamese
 * diacritics (u + combining dot below) while the main translation comes back
 * composed. Un-normalized, the two render differently and compare unequal.
 */
function toNfc(value) {
  return String(value || "").normalize("NFC");
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

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

async function lookupVocabulary(rawText, rawContext) {
  const text = sanitizeSelection(rawText);
  if (!text) throw new Error("Select a word or phrase first.");

  const settings = await getSettings();
  const context = prepareContext(rawContext, text, settings);
  const singleWord = isSingleWord(text);

  const [translation, dictionary, contextTranslation] = await Promise.allSettled([
    translateToVietnamese(text, settings),
    singleWord ? lookupDictionaryDetails(text) : Promise.resolve(null),
    context ? translateSentence(context, settings) : Promise.resolve(null),
  ]);

  const translationData = translation.status === "fulfilled" ? translation.value : null;
  const dictionaryData = dictionary.status === "fulfilled" ? dictionary.value : null;
  const contextData = contextTranslation.status === "fulfilled" ? contextTranslation.value : null;
  const errors = [];

  if (translation.status === "rejected") errors.push(toUserError(translation.reason));
  if (dictionary.status === "rejected" && singleWord) errors.push(toUserError(dictionary.reason));

  return {
    text,
    normalized: normalizeText(text),
    meaning: translationData ? translationData.meaning : "",
    generalMeaning: translationData ? translationData.generalMeaning || "" : "",
    alternatives: translationData ? translationData.alternatives || [] : [],
    isGlossary: Boolean(translationData && translationData.isGlossary),
    translationProvider: translationData ? translationData.provider : "",
    ipa: dictionaryData ? dictionaryData.ipa : "",
    dictionaryText: dictionaryData ? dictionaryData.headword : "",
    audioUrl: dictionaryData ? dictionaryData.audioUrl : "",
    example: dictionaryData ? dictionaryData.example : "",
    definition: dictionaryData ? dictionaryData.definition : "",
    partOfSpeech: dictionaryData ? dictionaryData.partOfSpeech : "",
    contextSentence: contextData ? context : "",
    contextMeaning: contextData ? contextData.meaning : "",
    cambridgeUrl: buildCambridgeUrl(text),
    ipaProvider: dictionaryData ? dictionaryData.provider : "",
    isPhrase: !singleWord,
    errors,
  };
}

/** The sentence around the selection, kept only when it adds something. */
function prepareContext(rawContext, text, settings) {
  if (!settings.contextTranslationEnabled) return "";
  const context = String(rawContext || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_LENGTH);
  if (!context) return "";
  if (normalizeText(context) === normalizeText(text)) return "";
  if (context.length < text.length + 8) return "";
  return context;
}

async function translateToVietnamese(text, settings) {
  const glossaryHit = settings.techGlossaryEnabled ? lookupGlossary(text) : null;
  const machine = await translateWithProviders(text, settings).catch((error) => {
    if (glossaryHit) return null;
    throw error;
  });

  if (!glossaryHit) {
    return {
      meaning: machine.meaning,
      generalMeaning: "",
      alternatives: machine.alternatives || [],
      provider: machine.provider,
      isGlossary: false,
    };
  }

  const machineMeaning = machine ? machine.meaning : "";
  const alternatives = machine ? machine.alternatives || [] : [];
  // Only worth a line of its own when there is no per-part-of-speech sense list
  // to carry the everyday meaning: a bare verb like "commit" translates to
  // something useless ("làm") on its own, but its sense list is good.
  const showGeneral =
    machineMeaning &&
    !alternatives.length &&
    AMBIGUOUS_TECH_TERMS.has(normalizeText(text)) &&
    normalizeText(machineMeaning) !== normalizeText(glossaryHit.meaning);

  return {
    meaning: glossaryHit.meaning,
    generalMeaning: showGeneral ? machineMeaning : "",
    alternatives,
    provider: machine ? `IT glossary + ${machine.provider}` : "IT glossary",
    isGlossary: true,
  };
}

async function translateSentence(sentence, settings) {
  const result = await translateWithProviders(sentence, settings, { withAlternatives: false });
  return { meaning: result.meaning, provider: result.provider };
}

/** Runs the configured provider chain and returns the first success. */
async function translateWithProviders(text, settings, options = {}) {
  const chain = buildProviderChain(settings);
  const failures = [];

  for (const provider of chain) {
    try {
      if (provider === "google") return await translateWithGoogle(text, options);
      if (provider === "deepl") return await translateWithDeepL(text, settings);
      if (provider === "mymemory") return await translateWithMyMemory(text, settings);
    } catch (error) {
      failures.push(`${provider}: ${toUserError(error)}`);
      console.warn(`Translation via ${provider} failed.`, error);
    }
  }

  throw new Error(`No Vietnamese meaning found. ${failures.join("; ")}`.trim());
}

function buildProviderChain(settings) {
  const hasDeepL = Boolean(settings.deeplApiKey);

  if (settings.translationProvider === "deepl" && hasDeepL) {
    return ["deepl", "google", "mymemory"];
  }
  if (settings.translationProvider === "google") {
    return hasDeepL ? ["google", "deepl", "mymemory"] : ["google", "mymemory"];
  }
  if (settings.translationProvider === "mymemory") {
    return ["mymemory", "google"];
  }
  // auto: Google first — it is the closest match to translate.google.com output
  // and is the only provider that also returns per-part-of-speech senses.
  return hasDeepL ? ["google", "deepl", "mymemory"] : ["google", "mymemory"];
}

function lookupGlossary(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  if (normalized === "it" && text === text.toUpperCase()) {
    return { meaning: "công nghệ thông tin (IT)" };
  }

  for (const candidate of getWordFormCandidates(normalized)) {
    if (TECH_GLOSSARY[candidate]) return { meaning: TECH_GLOSSARY[candidate] };
  }

  return null;
}

/**
 * Google Translate's public web endpoint — the same engine behind
 * translate.google.com, so output matches what the user would get by pasting
 * the text there. With dj=1 the reply is plain JSON; the `dict` block carries
 * the per-part-of-speech senses that make this useful for vocabulary work.
 */
async function translateWithGoogle(text, options = {}) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "vi");
  url.searchParams.set("hl", "vi");
  url.searchParams.set("dj", "1");
  url.searchParams.append("dt", "t");
  if (options.withAlternatives !== false) url.searchParams.append("dt", "bd");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Google Translate lookup failed (${response.status}).`);

  const data = await response.json();
  const meaning = toNfc(
    (data.sentences || [])
      .map((sentence) => sentence.trans || "")
      .join("")
  ).trim();

  if (!meaning) throw new Error("Google Translate returned no translation.");

  return {
    meaning,
    alternatives: parseGoogleAlternatives(data, meaning),
    provider: "Google Translate",
  };
}

function parseGoogleAlternatives(data, primaryMeaning) {
  const groups = Array.isArray(data.dict) ? data.dict : [];
  const seen = new Set([normalizeText(primaryMeaning)]);

  return groups
    .map((group) => {
      const terms = (group.terms || [])
        .map((term) => toNfc(term).trim())
        .filter((term) => {
          const key = normalizeText(term);
          if (!term || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 4);

      return { partOfSpeech: toNfc(group.pos).trim(), terms };
    })
    .filter((group) => group.terms.length)
    .slice(0, 3);
}

async function translateWithDeepL(text, settings) {
  if (!settings.deeplApiKey) throw new Error("No DeepL API key configured.");

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

  return { meaning, alternatives: [], provider: "DeepL" };
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

  return { meaning, alternatives: [], provider: "MyMemory" };
}

async function lookupDictionaryDetails(word) {
  const candidates = getWordFormCandidates(word.toLowerCase());
  let firstUsableDetails = null;

  for (const candidate of candidates) {
    try {
      const details = await fetchDictionaryDetails(candidate);
      if (details && details.ipa) return details;
      if (details && !firstUsableDetails) firstUsableDetails = details;
    } catch (error) {
      console.warn(`Dictionary lookup failed for "${candidate}".`, error);
    }
  }

  if (firstUsableDetails) return firstUsableDetails;
  throw new Error("No dictionary details found for this word.");
}

async function fetchDictionaryDetails(word) {
  const response = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
  );

  if (!response.ok) return null;

  const data = await response.json();
  const entries = Array.isArray(data) ? data : [];
  const headword = (entries[0] && entries[0].word) || word;
  const phonetics = entries.flatMap((entry) => entry.phonetics || []);
  const phonetic =
    phonetics.find((item) => item.text && item.text.trim()) ||
    entries.find((entry) => entry.phonetic && entry.phonetic.trim());
  const ipa = (phonetic && (phonetic.text || phonetic.phonetic)) || "";
  const audio = phonetics.find((item) => item.audio && item.audio.trim());
  const meanings = entries.flatMap((entry) => entry.meanings || []);
  const definitions = meanings.flatMap((meaning) =>
    (meaning.definitions || []).map((definition) => ({
      ...definition,
      partOfSpeech: meaning.partOfSpeech || "",
    }))
  );
  const example = definitions.find((definition) => definition.example && definition.example.trim());
  const definition = definitions.find((item) => item.definition && item.definition.trim());

  if (!ipa && !audio && !example && !definition) return null;
  return {
    ipa,
    headword,
    audioUrl: normalizeAudioUrl(audio && audio.audio),
    example: example ? example.example : "",
    definition: definition ? definition.definition : "",
    partOfSpeech: definition ? definition.partOfSpeech : "",
    provider: "Free Dictionary API",
  };
}

function getWordFormCandidates(word) {
  const normalized = normalizeText(word);
  const candidates = [normalized];

  if (normalized.endsWith("ies") && normalized.length > 4) {
    candidates.push(`${normalized.slice(0, -3)}y`);
  }

  if (normalized.endsWith("ves") && normalized.length > 4) {
    candidates.push(`${normalized.slice(0, -3)}f`);
    candidates.push(`${normalized.slice(0, -3)}fe`);
  }

  if (/(ches|shes|xes|zes|ses)$/.test(normalized) && normalized.length > 3) {
    candidates.push(normalized.slice(0, -2));
  }

  if (normalized.endsWith("s") && !normalized.endsWith("ss") && normalized.length > 3) {
    candidates.push(normalized.slice(0, -1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function normalizeAudioUrl(value) {
  const audioUrl = String(value || "").trim();
  if (!audioUrl) return "";
  return sanitizeHttpUrl(audioUrl.startsWith("//") ? `https:${audioUrl}` : audioUrl);
}

// ---------------------------------------------------------------------------
// Pronunciation
// ---------------------------------------------------------------------------

/**
 * Plays a word's pronunciation.
 *
 * The audio is fetched here, in the service worker, and handed to the offscreen
 * document as a data: URL rather than as a link for it to load itself. Two
 * things make that necessary: only this context has the host permissions that
 * allow a cross-origin fetch, and Google's text-to-speech endpoint answers a
 * browser media request with something that is not decodable audio, while a
 * plain fetch of the same URL returns the mp3. Playback then happens in the
 * offscreen document because a service worker has no <audio> element, and the
 * content script cannot be used: a page's own Content-Security-Policy governs
 * media it loads.
 */
async function speak(rawText, rawAudioUrl, lang) {
  const text = sanitizeSelection(rawText);
  const audioUrl = sanitizeHttpUrl(rawAudioUrl);
  if (!text && !audioUrl) throw new Error("Nothing to pronounce.");

  const candidates = [
    { url: audioUrl, source: "dictionary recording" },
    { url: buildGoogleTtsUrl(text, lang || "en"), source: "Google text-to-speech" },
  ].filter((candidate) => candidate.url);

  let audio = null;
  const failures = [];
  for (const candidate of candidates) {
    try {
      audio = { dataUrl: await fetchAudioDataUrl(candidate.url), source: candidate.source };
      break;
    } catch (error) {
      failures.push(`${candidate.source}: ${toUserError(error)}`);
    }
  }

  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "VC_OFFSCREEN_PLAY",
    dataUrl: audio ? audio.dataUrl : "",
    source: audio ? audio.source : "",
    text,
    lang: lang || "en",
  });

  if (!response || response.ok === false) {
    const reason = (response && response.error) || "Could not play the pronunciation.";
    throw new Error([reason, ...failures].join(" "));
  }

  return response.data || { source: audio ? audio.source : "speech synthesis" };
}

/** Downloads audio and inlines it, so the player never makes its own request. */
async function fetchAudioDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed (${response.status})`);

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("audio/")) {
    throw new Error(`served ${contentType.split(";")[0]} instead of audio`);
  }

  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("empty response");
  if (buffer.byteLength > MAX_AUDIO_BYTES) throw new Error("audio too large");

  return `data:${contentType || "audio/mpeg"};base64,${toBase64(buffer)}`;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function buildGoogleTtsUrl(text, lang) {
  const trimmed = String(text || "").slice(0, 180);
  if (!trimmed) return "";
  const url = new URL("https://translate.google.com/translate_tts");
  url.searchParams.set("ie", "UTF-8");
  url.searchParams.set("client", "tw-ob");
  url.searchParams.set("tl", lang || "en");
  url.searchParams.set("q", trimmed);
  return url.toString();
}

let offscreenCreation = null;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) throw new Error("This Chrome version cannot play audio in the background.");

  if (await hasOffscreenDocument()) return;
  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }

  offscreenCreation = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Play word pronunciation audio.",
    })
    .catch((error) => {
      // A parallel click may have created it first; that is not a failure.
      if (!/single offscreen document/i.test(String(error && error.message))) throw error;
    })
    .finally(() => {
      offscreenCreation = null;
    });

  await offscreenCreation;
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

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
    generalMeaning: sanitizeOptional(sourceItem.generalMeaning),
    ipa: sanitizeOptional(sourceItem.ipa),
    dictionaryText: sanitizeOptional(sourceItem.dictionaryText),
    audioUrl: sanitizeOptional(sourceItem.audioUrl),
    example: sanitizeOptional(sourceItem.example),
    contextSentence: sanitizeOptional(sourceItem.contextSentence),
    contextMeaning: sanitizeOptional(sourceItem.contextMeaning),
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
