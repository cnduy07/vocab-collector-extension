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

const fields = {
  translationProvider: document.getElementById("translationProvider"),
  techGlossaryEnabled: document.getElementById("techGlossaryEnabled"),
  contextTranslationEnabled: document.getElementById("contextTranslationEnabled"),
  deeplApiKey: document.getElementById("deeplApiKey"),
  deeplEndpoint: document.getElementById("deeplEndpoint"),
  myMemoryEmail: document.getElementById("myMemoryEmail"),
  saveRemoteEnabled: document.getElementById("saveRemoteEnabled"),
  sheetsWebhookUrl: document.getElementById("sheetsWebhookUrl"),
  sheetsWebhookToken: document.getElementById("sheetsWebhookToken"),
};

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  window.setTimeout(() => {
    if (status.textContent === message) {
      status.textContent = "";
      status.classList.remove("error");
    }
  }, isError ? 15000 : 2500);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
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

function saveSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ vcSettings: readForm() }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function readForm() {
  return {
    translationProvider: fields.translationProvider.value || DEFAULT_SETTINGS.translationProvider,
    techGlossaryEnabled: fields.techGlossaryEnabled.checked,
    contextTranslationEnabled: fields.contextTranslationEnabled.checked,
    deeplApiKey: fields.deeplApiKey.value.trim(),
    deeplEndpoint: fields.deeplEndpoint.value.trim() || DEFAULT_SETTINGS.deeplEndpoint,
    myMemoryEmail: fields.myMemoryEmail.value.trim(),
    saveRemoteEnabled: fields.saveRemoteEnabled.checked,
    sheetsWebhookUrl: fields.sheetsWebhookUrl.value.trim(),
    sheetsWebhookToken: fields.sheetsWebhookToken.value.trim(),
  };
}

function render(settings) {
  fields.translationProvider.value = settings.translationProvider || DEFAULT_SETTINGS.translationProvider;
  fields.techGlossaryEnabled.checked = settings.techGlossaryEnabled !== false;
  fields.contextTranslationEnabled.checked = settings.contextTranslationEnabled !== false;
  fields.deeplApiKey.value = settings.deeplApiKey || "";
  fields.deeplEndpoint.value = settings.deeplEndpoint || DEFAULT_SETTINGS.deeplEndpoint;
  fields.myMemoryEmail.value = settings.myMemoryEmail || "";
  fields.saveRemoteEnabled.checked = Boolean(settings.saveRemoteEnabled);
  fields.sheetsWebhookUrl.value = settings.sheetsWebhookUrl || "";
  fields.sheetsWebhookToken.value = settings.sheetsWebhookToken || "";
}

function loadSettings() {
  chrome.storage.local.get({ vcSettings: DEFAULT_SETTINGS }, (data) => {
    render({ ...DEFAULT_SETTINGS, ...(data.vcSettings || {}) });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  document.getElementById("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings()
      .then(() => setStatus("Settings saved."))
      .catch((error) => setStatus(error.message, true));
  });

  document.getElementById("testLookup").addEventListener("click", async () => {
    const button = document.getElementById("testLookup");
    button.disabled = true;
    button.textContent = "Testing...";
    setStatus("Testing lookup...");

    try {
      await saveSettings();
      const result = await sendRuntimeMessage({ type: "VC_TEST_LOOKUP" });
      const meaning = result.meaning || "no Vietnamese meaning";
      const ipa = result.ipa || "no IPA";
      const via = result.translationProvider || "unknown engine";
      setStatus(`Lookup ok via ${via}: commit = ${meaning}; ${ipa}`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Test lookup";
    }
  });

  document.getElementById("testSheets").addEventListener("click", async () => {
    const button = document.getElementById("testSheets");
    button.disabled = true;
    button.textContent = "Testing...";
    setStatus("Sending test row...");

    try {
      await saveSettings();
      const result = await sendRuntimeMessage({ type: "VC_TEST_SHEETS_SYNC" });
      setStatus(result.message || "Test row sent.");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Test Google Sheets sync";
    }
  });

  document.getElementById("reset").addEventListener("click", () => {
    chrome.storage.local.set({ vcSettings: DEFAULT_SETTINGS }, () => {
      render(DEFAULT_SETTINGS);
      setStatus("Defaults restored.");
    });
  });
});
