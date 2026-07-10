# Vocabulary Collector — Chrome Extension

Vocabulary Collector helps you collect useful English words while reading. Select a word or phrase on a webpage, review the Vietnamese meaning, IPA, sound link, and example, then save it locally or sync it to a personal Google Sheet.

## Current status

| Piece | Status |
|---|---|
| Detecting text selection and showing the popup | Real |
| Popup positioning near the selection | Real |
| Cambridge Dictionary link | Real, with search fallback for phrases |
| Wiktionary link | Real |
| Right-click "Add to Vocabulary Collector" fallback | Real |
| Vietnamese meaning | Built-in glossary for selected tech terms, DeepL if configured, otherwise MyMemory |
| IPA, sound link, and example | Real lookup for single English words via Free Dictionary API, with plural-to-singular fallback |
| Save button | Real local save, with optional Google Sheets sync |
| Toolbar popup | Real local list with meaning, IPA, example/sound links, sync state, per-item delete, and sync-all repair |
| Settings page | Real, used for DeepL/MyMemory/Google Sheets configuration |

## How to load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `vocab-collector-extension`.
5. The extension should appear with the "V" icon.

After code changes, click **Reload** on the extension card in `chrome://extensions`.

## How to use

1. Open a normal webpage.
2. Select an English word, such as `salient`.
3. A popup should appear near the selection.
4. Wait for the Vietnamese meaning, IPA, sound link, and example lookup.
5. Use the dictionary buttons if you want to inspect the word externally.
6. Click **Save**.
7. Open the toolbar popup to review recent saves.
8. Click **Delete** beside a saved item if you want to remove it from this browser.

For phrases, the extension still translates the phrase, but IPA, sound links, and examples are intentionally skipped.
For plural words, the extension tries the selected word first, then likely singular forms. For example, `developers` can show the IPA for `developer`.

## Settings

Open the extension toolbar popup and click **Settings**.

### Lookup settings

- **DeepL API key**: optional. If present, DeepL is used first.
- **DeepL endpoint**: defaults to `https://api-free.deepl.com/v2/translate`.
- **MyMemory contact email**: optional, but recommended by MyMemory for higher-volume usage.

The extension has a small built-in glossary for common tech terms such as `developer` and `IT` so those words get a more natural Vietnamese meaning. If no glossary entry matches, DeepL is used when configured; otherwise the extension falls back to MyMemory.

Click **Test lookup** in settings to verify that the extension background worker can reach the lookup APIs. The test looks up `salient` and should return a Vietnamese meaning plus IPA when available.

### If lookup fails on a webpage

Try these in order:

1. Reload the current webpage. This is required after reloading or updating an unpacked extension because old content scripts can no longer talk to the new background worker.
2. Reload the extension in `chrome://extensions`.
3. Open extension Settings and click **Test lookup**.
4. If **Test lookup** works but the webpage popup still fails, reload that webpage again and select the word once more.
5. If **Test lookup** fails, check the Settings message. A bad DeepL key can fail first, but the extension should fall back to MyMemory.

### Google Sheets sync

The extension can sync new saves to a Google Sheet through a Google Apps Script Web App URL.

1. Create a Google Sheet.
2. Open **Extensions → Apps Script**.
3. Add the Apps Script below. It keeps the visible Sheet columns focused on learning: English, Vietnamese meaning, IPA, sound link, example, and Cambridge Dictionary link.
4. Deploy it as a **Web app**.
5. Set access to your preferred level.
6. Paste the Web App URL into the extension settings.
7. Add the same long random webhook secret in Apps Script and the extension settings.
8. Turn on **Sync new saves to Google Sheets**.
9. Click **Test Google Sheets sync** in the extension settings.
10. Confirm a `__sync_test__` row appears in the English column.
11. Use the toolbar popup's **Sync all** button if local storage and the Sheet drift apart.

The Google Sheet lives in your Google Drive like any other Sheet. Ticking **Sync new saves to Google Sheets** is not enough by itself; the extension also needs the deployed Web App URL so it knows which Sheet to append to.

Example Apps Script:

```js
const SHEET_ID = "paste-your-google-sheet-id-here";
const EXPECTED_TOKEN = "paste-a-long-random-secret-here";
const HEADERS = [
  "english",
  "vietnamese_meaning",
  "ipa",
  "audio_url",
  "example",
  "cambridge_dictionary"
];

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({ ok: true, message: "Vocabulary Collector Web App is alive." });
}

function getVocabularySheet() {
  assertConfigured();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);
  return sheet;
}

function assertConfigured() {
  if (SHEET_ID === "paste-your-google-sheet-id-here") {
    throw new Error("Replace SHEET_ID before using this Web App.");
  }
  if (EXPECTED_TOKEN === "paste-a-long-random-secret-here") {
    throw new Error("Replace EXPECTED_TOKEN with your own long random secret.");
  }
}

function ensureHeaders(sheet) {
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (firstRow[0] !== HEADERS[0]) {
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function normalizeEnglish(value) {
  return String(value || "").trim().toLowerCase();
}

function buildVocabularyRow(data) {
  const english = data.english || data.text || "";
  return [
    english,
    data.vietnameseMeaning || data.meaning || "",
    data.ipa || "",
    data.audioUrl || "",
    data.example || "",
    data.cambridgeUrl || ""
  ];
}

function findExistingRow(sheet, data) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const targetEnglish = normalizeEnglish(data.english || data.text);
  if (!targetEnglish) return 0;

  const rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;
    const currentEnglish = normalizeEnglish(row[0]);
    const legacyTextColumn = normalizeEnglish(row[2]);

    if (currentEnglish === targetEnglish) return rowNumber;
    if (legacyTextColumn === targetEnglish) return rowNumber;
  }

  return 0;
}

function upsertVocabularyRow(data) {
  const sheet = getVocabularySheet();
  const row = buildVocabularyRow(data);
  const existingRow = findExistingRow(sheet, data);

  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, HEADERS.length).setValues([row]);
    return "updated";
  }

  sheet.appendRow(row);
  return "inserted";
}

function authorizeAndTest() {
  upsertVocabularyRow({
    english: "__apps_script_manual_test__",
    vietnameseMeaning: "Manual Apps Script authorization test",
    ipa: "",
    audioUrl: "",
    example: "Manual Apps Script authorization test",
    cambridgeUrl: ""
  });

  return jsonResponse({ ok: true, message: "Manual test row appended." });
}

function doPost(e) {
  try {
    assertConfigured();

    if (!e || !e.postData) {
      return jsonResponse({
        ok: false,
        error: "doPost must be called by the deployed Web App URL. In the editor, run authorizeAndTest instead."
      });
    }

    const data = JSON.parse(e.postData.contents || "{}");

    if (data.token !== EXPECTED_TOKEN) {
      return jsonResponse({ ok: false, error: "Unauthorized" });
    }

    const action = upsertVocabularyRow(data);

    return jsonResponse({ ok: true, action });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message });
  }
}
```

Find the Sheet ID in your Google Sheet URL:

```text
https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit
```

If sync is off or the request fails, the word is still saved locally. The toolbar popup marks those records as local-only. After fixing sync, click **Sync all** in the toolbar popup to push every local item to the Sheet.

Deleting an item in the toolbar popup currently removes it from local extension storage only. If that item was already synced, delete the row from Google Sheets manually for now. Manual rows such as `__sync_test__` and `__apps_script_manual_test__` are expected to exist only in the Sheet.

### Security notes

- The repo does not contain your real Sheet ID, Web App URL, DeepL key, or webhook secret.
- Settings are stored in Chrome extension local storage on your computer. Do not use this on a shared Chrome profile.
- The extension sends only the selected word or phrase and lookup fields to Google Sheets. It does not send the source page title or URL.
- Older local records created before this cleanup may still contain source page title/URL in Chrome local storage. Use **Clear local data** if you want to remove old local records.
- Your Google Sheet stays private in Google Drive unless you share the Sheet itself.
- The Apps Script Web App may need **Who has access: Anyone** so the extension can call it, but `doPost` rejects requests without your webhook secret.
- Keep the Web App URL and webhook secret private. Anyone who has both could write rows to the Sheet through the Web App.

### If local and Google Sheet do not match

Common reasons:

1. Some words were saved while Sheets sync was broken, so they stayed local-only.
2. You deleted a word locally; remote delete is not implemented yet, so the Sheet keeps that row.
3. Test rows like `__sync_test__` or `__apps_script_manual_test__` exist only in the Sheet.
4. Older Sheet rows used the previous metadata-heavy column format.

Repair path:

1. Replace Apps Script with the latest upsert script above.
2. Run `authorizeAndTest`.
3. Redeploy the Web App as a new version.
4. Reload the extension in `chrome://extensions`.
5. Open the toolbar popup.
6. Click **Sync all**.

This pushes local storage to the Sheet. It does not delete extra Sheet rows that are not in local storage.

### If no rows appear in Google Sheets

Check these first:

1. Reload the extension in `chrome://extensions` after code changes.
2. Use the deployed Web App URL ending in `/exec`, not the test URL ending in `/dev`.
3. In Apps Script deployment settings, use **Execute as: Me**.
4. Set access so the extension can call it, usually **Anyone** or **Anyone with the link**.
5. Make sure the webhook secret in Apps Script exactly matches the extension's **Webhook secret** field.
6. Click **Test Google Sheets sync** in extension settings.
7. Open Apps Script **Executions** to see whether `doPost` ran or failed.
8. If you edited the Apps Script after deploying, create a **new deployment version** or edit the existing deployment to use the latest version.

The extension now expects Apps Script to return JSON like `{ ok: true }`. If Google returns an HTML login/permission page instead, the settings page will show an error instead of silently marking the save as synced.

If the error preview starts with HTML such as `<!DOCTYPE html>`, `Login`, or `Sign in`, your deployment access is blocking the extension. Redeploy the Web App with **Execute as: Me** and access set to **Anyone**. The webhook secret protects the write endpoint, so the Web App can be callable without exposing your Google account credentials.

If the preview says `Authorization needed`, Google is asking for OAuth permission before the script can write to your Sheet. Fix it like this:

1. In Apps Script, paste the latest sample script above.
2. Replace `SHEET_ID` and `EXPECTED_TOKEN`.
3. Select the `authorizeAndTest` function, not `doPost`.
4. Click **Run**.
5. Approve the requested Google permissions.
6. Confirm a `__apps_script_manual_test__` row appears in the Sheet.
7. Click **Deploy → Manage deployments**.
8. Edit the Web App deployment.
9. Set **Execute as** to **Me**.
10. Set **Who has access** to **Anyone**.
11. Select a **new version** if you changed the code.
12. Copy the deployed URL ending in `/exec`.
13. Paste that URL into the extension settings and test again.

Do not click **Run** on `doPost` in the Apps Script editor. `doPost(e)` only receives `e.postData` when the deployed Web App receives a POST request from the extension.

If the preview says the file does not exist or mentions a 404/405-style Google page, the URL is usually wrong. Copy the deployed Web App URL from **Deploy → Manage deployments**, and make sure it ends in `/exec`.

## How to test

1. Load or reload the unpacked extension.
2. Select `salient` on a webpage.
   - The popup should show a Vietnamese meaning.
   - IPA should appear for the single word.
3. Click the Cambridge and Wiktionary buttons.
   - Each should open the expected external dictionary page.
4. Select a phrase such as `to be honest`.
   - The popup should show a Vietnamese meaning.
   - IPA should stay empty.
5. Click **Save**.
   - The button should show a saved state.
   - The toolbar popup should show the saved item.
6. Save the same word again.
   - The popup should show **Already saved**.
7. Click **Delete** beside the saved item in the toolbar popup.
   - Confirm the prompt.
   - The item should disappear from the toolbar popup.
8. Configure Google Sheets sync and save a new word.
   - The row should appear in the Sheet.
   - The toolbar popup should show **Synced**.
9. Disable sync or use an invalid Web App URL and save a different word.
   - The item should still save locally.
   - The toolbar popup should mark it as local-only.

## Known limitations

- Google Sheets sync needs your own Apps Script Web App URL; this repo does not contain Google credentials.
- DeepL needs your own API key. Without it, MyMemory is used.
- IPA, sound links, and examples are for single English words only and depend on what the dictionary API returns. Plural words can fall back to likely singular forms for IPA.
- Text selected inside `contenteditable` fields, iframes, or some PDF viewers may not trigger the popup reliably. Use the right-click fallback when needed.
- Some webpages with unusual selection behavior may produce no selection rectangle, so the popup will not appear.

## Project plan

See `vocab_collector_idea_plan_updated.md` for the idea, architecture, phase status, and next milestones.
