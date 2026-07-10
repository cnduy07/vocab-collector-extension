function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderList(words) {
  const list = document.getElementById("list");
  if (!words.length) {
    list.innerHTML = '<div class="empty">No words saved yet. Select text on any page to try it.</div>';
    return;
  }
  list.innerHTML = words
    .map(
      (w, index) => `
      <div class="item">
        <div class="item-main">
          <strong>${escapeHtml(w.text)}</strong>
          <div class="item-meta">${renderMeta(w)}</div>
        </div>
        <div class="item-actions">
          <span class="date">${formatDate(w.createdAt)}</span>
          <button class="delete-item" data-delete-index="${index}" type="button">Delete</button>
        </div>
      </div>
    `
    )
    .join("");
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
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

function renderMeta(word) {
  const details = [];
  if (word.meaning) details.push(escapeHtml(word.meaning));
  if (word.ipa) details.push(`IPA: ${escapeHtml(word.ipa)}`);
  if (word.example) details.push(`Example: ${escapeHtml(word.example)}`);
  if (word.audioUrl) {
    const soundLink = renderLink(word.audioUrl, "Sound");
    if (soundLink) details.push(soundLink);
  }
  if (word.cambridgeUrl) {
    const cambridgeLink = renderLink(word.cambridgeUrl, "Cambridge");
    if (cambridgeLink) details.push(cambridgeLink);
  }

  const sync = word.synced
    ? '<span class="sync-ok">Synced</span>'
    : word.syncError
      ? '<span class="sync-warn">Local only</span>'
      : '<span>Local</span>';

  details.push(sync);
  return details.join(" · ");
}

function renderLink(url, label) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return "";
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

function deleteWordAt(index) {
  chrome.storage.local.get({ savedWords: [] }, (data) => {
    const words = Array.isArray(data.savedWords) ? data.savedWords : [];
    const word = words[index];
    if (!word) return;

    const ok = window.confirm(`Delete "${word.text}" from this browser?`);
    if (!ok) return;

    const updated = words.filter((_, currentIndex) => currentIndex !== index);
    chrome.storage.local.set({ savedWords: updated }, () => renderList(updated));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get({ savedWords: [] }, (data) => renderList(data.savedWords));

  document.getElementById("list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-index]");
    if (!button) return;

    deleteWordAt(Number(button.dataset.deleteIndex));
  });

  document.getElementById("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("syncAll").addEventListener("click", async () => {
    const button = document.getElementById("syncAll");
    button.disabled = true;
    button.textContent = "Syncing...";
    setStatus("Syncing local words to Sheet...");

    try {
      const result = await sendRuntimeMessage({ type: "VC_SYNC_ALL_LOCAL" });
      setStatus(result.message || "Sync complete.");
      chrome.storage.local.get({ savedWords: [] }, (data) => renderList(data.savedWords));
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Sync all";
    }
  });

  document.getElementById("clear").addEventListener("click", () => {
    chrome.storage.local.set({ savedWords: [] }, () => renderList([]));
  });
});
