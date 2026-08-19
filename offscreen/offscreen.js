// Offscreen document: the only place in the extension that can play audio.
// A service worker has no <audio> element, and a content script cannot be used
// because the host page's Content-Security-Policy governs media it loads.
//
// The audio arrives already downloaded, as a data: URL, because only the
// service worker holds the host permissions needed to fetch it (see speak() in
// background/background.js). If nothing could be fetched, or the bytes will not
// decode, the browser's built-in speech synthesis says the word instead.

const PLAY_TIMEOUT_MS = 6000;

let currentAudio = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;

  if (message.type === "VC_OFFSCREEN_PLAY") {
    play(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function play({ dataUrl, source, text, lang }) {
  stopCurrent();

  const failures = [];
  if (dataUrl) {
    try {
      await playUrl(dataUrl);
      return { source: source || "audio" };
    } catch (error) {
      failures.push(`${source || "audio"}: ${error.message}`);
    }
  }

  try {
    await speakLocally(text, lang);
    return { source: "speech synthesis" };
  } catch (error) {
    failures.push(`speech synthesis: ${error.message}`);
  }

  throw new Error(`Could not play the pronunciation. ${failures.join("; ")}`);
}

function stopCurrent() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (self.speechSynthesis) self.speechSynthesis.cancel();
}

function playUrl(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    currentAudio = audio;

    const timer = setTimeout(() => {
      cleanup();
      audio.pause();
      reject(new Error("timed out"));
    }, PLAY_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("error", onError);
    }

    function onPlaying() {
      cleanup();
      resolve();
    }

    function onError() {
      cleanup();
      reject(new Error(audio.error ? audio.error.message || `code ${audio.error.code}` : "could not decode audio"));
    }

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("error", onError);
    audio.play().catch((error) => {
      cleanup();
      reject(new Error(error.message || "playback was blocked"));
    });
  });
}

function speakLocally(text, lang) {
  return new Promise((resolve, reject) => {
    if (!text) {
      reject(new Error("nothing to say"));
      return;
    }
    if (!self.speechSynthesis || !self.SpeechSynthesisUtterance) {
      reject(new Error("not available"));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === "vi" ? "vi-VN" : "en-US";
    utterance.rate = 0.95;
    utterance.onstart = () => resolve();
    utterance.onerror = () => reject(new Error("speech synthesis failed"));
    self.speechSynthesis.speak(utterance);

    // Some platforms fire neither event; assume success shortly after queueing.
    setTimeout(resolve, 900);
  });
}
