# Upgrade notes — v0.1.0 → v0.2.0

This document explains what was wrong, what was changed, and every bug that was
found along the way, with the reasoning behind each fix.

Two kinds of problem are described below, and they are kept separate on purpose:

- **Section 1** is the defect that prompted the upgrade: translation quality.
- **Section 2** lists bugs found *while building and testing the new code*.
  Bug 2.1 is a real one that would have shipped. Bugs 2.2–2.5 were caught before
  release; they were in code written during this upgrade, not in v0.1.0.

---

## 1. The reported problem: translation was not good enough for technical reading

### What was wrong

v0.1.0 translated with **MyMemory**, a translation-memory service. It is free and
needs no key, but it is weak on technical English. Reading software
documentation, the meanings it produced were often literal and wrong:

| word in a tech document | MyMemory gave | what it actually means |
|---|---|---|
| commit | cam kết (*to pledge*) | bản ghi thay đổi trong Git |
| thread | sợi chỉ (*sewing thread*) | luồng thực thi |
| socket | ổ cắm (*wall socket*) | đầu nối mạng |
| deprecated | phản đối (*to disapprove*) | không còn được khuyến nghị dùng |
| race condition | điều kiện chủng tộc (*racial condition*) | lỗi tranh chấp thứ tự thực thi |

### Root cause

Two separate causes, which is why the fix has two separate parts.

1. **The engine was the weakest available.** v0.1.0 used DeepL only if you
   supplied an API key, and otherwise fell back to MyMemory. Most of the time it
   was running on the fallback.
2. **No engine knows which domain you are reading.** Even a strong general
   engine translates an isolated word by its most common everyday sense.
   `commit` in a Git sentence and `commit` in a legal sentence are different
   words, and a translator given one word with no context cannot tell them
   apart.

### The fix, in three layers

**Layer 1 — a much better engine, with no setup.**

Lookups now go through Google Translate's public web endpoint:

```
https://translate.googleapis.com/translate_a/single
    ?client=gtx&sl=auto&tl=vi&hl=vi&dj=1&dt=t&dt=bd&q=<text>
```

This is the same engine as translate.google.com, so a word comes back with the
wording you would get by pasting it there. It needs no API key.

Two parameters matter:

- `dj=1` asks for plain JSON instead of Google's positional-array format, so the
  response can be parsed without index guessing.
- `dt=bd` adds a **dictionary block**: the word's other senses grouped by part of
  speech. This is why the card can now show `danh từ: …  ·  động từ: …` under the
  main meaning. No other engine in the chain returns this.

Engine order is configurable in Settings, and a failing engine falls through to
the next one instead of returning an empty card:

```
IT glossary → Google Translate → DeepL (if a key is set) → MyMemory
```

**Layer 2 — a domain glossary that overrides the engine.**

`background/glossary.js` is new: 327 software, web, data, concurrency, and ops
terms with hand-written Vietnamese meanings. A glossary hit wins over the
machine translation and is marked with an **IT** tag on the card.

Inflected forms are matched through the existing `getWordFormCandidates()`
helper, so selecting `threads` finds the `thread` entry.

For terms whose everyday meaning is genuinely different — `commit`, `thread`,
`socket`, `port`, `fork`, and 27 more, listed in
`AMBIGUOUS_TECH_TERMS` — the everyday meaning is shown as well, so the card does
not hide the fact that the word has a second life outside software.

**Layer 3 — the sentence, not just the word.**

The content script now finds the sentence the selection sits in and translates
that too, shown under a collapsible **In context** line.

`getContextSentence()` walks up to the nearest block element (`p`, `li`, `td`,
`pre`, …), reads its text, then expands from the selection outward to the nearest
sentence punctuation on each side. It bails out if the block is over 1500
characters, so a page that puts an entire article in one `<div>` cannot make the
card send a wall of text to the translator.

This is the layer that resolves ambiguity the glossary cannot: it shows how the
word is being used *in the document you are reading right now*.

### Result

Measured against live APIs, selecting a word inside a real sentence:

```
thread   → IT  luồng (đơn vị thực thi); chuỗi thảo luận
             danh từ: chỉ, dây nhỏ, đường chỉ may · động từ: xỏ kim
             In context: "Each request runs on its own thread in the worker pool."
                      → "Mỗi yêu cầu chạy trên luồng riêng của nó trong nhóm công nhân."

commit   → IT  commit — bản ghi thay đổi trong Git
             động từ: giao thác, hứa, ký thác, phạm
             /kəˈmɪt/
```

---

## 2. Bugs

### 2.1 The speaker button could never play real audio  ← would have shipped

**Symptom.** The speaker button worked, but always fell through to the browser's
built-in speech synthesis — the last-resort tier. Neither the dictionary
recording nor Google text-to-speech ever played.

**Investigation.** Three observations that only make sense together:

| probe | result |
|---|---|
| `curl` the Google TTS URL | `200`, `content-type: audio/mpeg`, 11328 bytes |
| `new Audio(url)` in a browser page | `MEDIA_ELEMENT_ERROR: Format error` (MediaError code 4) |
| `fetch(url)` in a browser page | throws `Failed to fetch` |

**Root cause.** Two independent blocks, and both had to be removed.

1. **Google serves different content to a browser media request.** The URL
   returns a real mp3 to a plain HTTP client, but a `<audio>` element receives
   something that is not decodable audio. Note this is *not* a CORS failure —
   media elements do not perform CORS checks. The bytes simply are not audio,
   which is why the error is a decode error and not a security error.
2. **A page cannot fetch that URL at all.** The response carries no
   `Access-Control-Allow-Origin`, so the browser blocks a cross-origin `fetch`
   from page context. A content script shares the host page's context for this
   purpose, so it is blocked too.

**Why the extension can do better.** `manifest.json` declares:

```json
"host_permissions": ["https://translate.google.com/*", "https://api.dictionaryapi.dev/*", …]
```

A `fetch` issued **from the service worker** is exempt from CORS for hosts listed
there. The service worker can therefore retrieve the mp3 exactly the way `curl`
does. No other context in the extension can.

**The fix.** All audio downloading moved into the service worker. `speak()` in
`background/background.js` now:

1. tries the dictionary recording, then the Google TTS URL;
2. rejects any response whose `content-type` is not `audio/*` — so a host that
   returns an HTML error page fails immediately with a clear message instead of
   producing a confusing decode error later;
3. rejects empty responses and anything over 2 MB;
4. base64-encodes the bytes into a `data:` URL and sends that to the offscreen
   document.

The offscreen document is now a dumb player: it receives audio that is already
downloaded and never issues a network request of its own, so neither CORS nor the
host page's Content-Security-Policy can interfere. If nothing could be fetched,
or the bytes will not decode, it speaks the word with `speechSynthesis`.

**Why an offscreen document at all?** A Manifest V3 service worker has no DOM and
therefore no `<audio>` element. The content script does have one, but media it
loads is governed by the *host page's* Content-Security-Policy, so the button
would be dead on any site with a strict `media-src`. An offscreen document runs
on the extension's own origin and is subject to neither restriction. It needs the
`"offscreen"` permission, which was added to the manifest.

**Verification.** Driven through the real code in a real browser:

| case | result |
|---|---|
| real mp3, fetched and inlined as a `data:` URL | `<audio>` reaches `playing` |
| URL that serves HTML instead of audio | rejected by the content-type check → speech synthesis |
| no audio URL at all | speech synthesis |

---

### 2.2 Vietnamese senses arrived with decomposed diacritics

**Symptom.** The senses line from Google's dictionary block would have rendered
with visibly different diacritics from the meaning line above it, and identical
meanings would have been listed twice.

**Root cause.** Google returns the two halves of its response in **different
Unicode normalization forms**:

| field | form | `sự chấp nhận` is… |
|---|---|---|
| `sentences[].trans` (main translation) | NFC — composed | 12 code units |
| `dict[].terms` (other senses) | NFD — decomposed | 15 code units |

In NFD, `ự` is stored as `ư` (U+01B0) followed by a combining dot below
(U+0323). It usually *looks* almost right, but the font composes it differently
from the precomposed character, so the two lines of the card do not match.

The second consequence is worse and invisible: the code removes a sense that
duplicates the primary meaning by comparing the two strings. `"sự cho phép"` in
NFC and `"sự cho phép"` in NFD are not equal in JavaScript, so the duplicate
survived the filter and the card listed the same meaning twice.

**The fix.** A `toNfc()` helper applied to the main translation, every sense
term, and every part-of-speech label, plus inside `normalizeText()` — which is
the function used for *all* string comparisons in the extension, including the
"already saved" check. Normalizing at the boundary means the rest of the code
never has to think about it.

---

### 2.3 The "everyday meaning" line was often noise

**Symptom.** For `commit`, the card showed `Nghĩa thường: làm` ("to do") under the
technical meaning. That is useless.

**Root cause.** For ambiguous technical terms the card showed the machine
translation of the **bare word**. A verb translated with no context around it
lands on some generic default; `commit` alone becomes `làm`. Meanwhile the
per-part-of-speech sense list directly underneath already carried the real
everyday senses — `giao thác, hứa, ký thác, phạm`.

So the card was spending a line, and vertical space, on the worst version of
information it was already showing better one line below.

**The fix.** The everyday-meaning line is now shown only when there is **no**
sense list to carry that information. When Google returns senses, they are
strictly better, and the card stays shorter.

---

### 2.4 An empty example still took up space

**Symptom.** A few pixels of dead vertical space in the card before a lookup
finished.

**Root cause.** A CSS ordering mistake. The example element was set to
`display: none` in a grouped rule, and then a later rule set
`display: -webkit-box` to enable the two-line clamp:

```css
.vc-senses, .vc-general, .vc-example { display: none; }
.vc-example { display: -webkit-box; -webkit-line-clamp: 2; }   /* wins */
```

Both selectors have the same specificity, so the later one wins and the element
was never actually hidden by CSS. It only looked hidden because JavaScript sets
an inline `display: none` after each lookup — which does not apply before the
first lookup returns.

**The fix.** `display` was removed from the second rule. `setLine()` sets
`-webkit-box` only when there is example text to show, so the clamp still works
and the element reserves nothing when empty.

---

### 2.5 Three glossary entries could never be reached

**Symptom.** None visible — dead code.

**Root cause.** Three keys were written with a parenthesised disambiguator:
`"scope (oauth)"`, `"instance (server)"`, `"throughput (ops)"`. Lookup keys are
matched against text the user selects on a page, and nobody selects
`scope (oauth)`. All three shadowed nothing and matched nothing.

**The fix.** Removed; the plain `scope`, `instance`, and `throughput` entries
already existed. The file was then checked for two more classes of error:

- **duplicate keys** — a JavaScript object literal silently keeps only the last
  of a repeated key, so a typo'd repeat would have quietly overridden an earlier
  entry with no warning. None found.
- **malformed keys** — any key with uppercase letters, stray whitespace, or
  punctuation that could never match a normalized selection. None remain.

327 entries, all valid lookup forms.

---

### 2.6 Not a bug: clicking inside the card

Worth writing down because it looked like a bug during testing.

The first automated test double-clicked a word in the third paragraph while the
card from the previous word was still open and overlapping it. The click landed
on the card, and the test reported that it had selected the Vietnamese word
`bản` — from the card's own text — and that the card had not updated.

That is correct behaviour. `isInsideOurUi()` checks the event's `composedPath()`
and ignores selections made inside the extension's own UI; otherwise the card
would restart a lookup on its own translation every time you tried to select
text in it. The test was fixed to dismiss the card first. The extension was not
changed.

---

## 3. Interface changes

- The card is **252 px** wide instead of 280 px, with tighter padding and type.
  It now carries more information — senses, context, a speaker button — in less
  vertical space than v0.1.0 used for less.
- **Dark mode**, via `prefers-color-scheme`. All colours are CSS custom
  properties defined once and redefined in the dark block.
- Emoji buttons (📘 📖) replaced with inline SVG icons, which render identically
  across platforms; emoji do not.
- A **speaker button** in the card, and one beside every saved word in the
  toolbar popup.
- `Escape` closes the card.
- The example is clamped to two lines, and the sentence translation is collapsed
  by default, so a long example or sentence cannot make the card grow without
  limit.

---

## 4. How this was tested

Three levels, because each one catches things the others cannot.

**Live API checks.** The Google Translate endpoint, Google TTS, and the Free
Dictionary API were called directly to confirm their real response shapes rather
than assumed ones. This is how the Unicode normalization bug (2.2) was found.

**The background worker, end to end.** `background.js` was loaded in Node with a
stubbed `chrome` API, and driven with real message payloads against the live
APIs. This exercised the full lookup pipeline — glossary, engine fallback,
dictionary, context — for eight terms.

**The real extension code in a real browser.** Chrome 151 has removed the
`--load-extension` command-line switch, so the extension cannot be installed
into a throwaway browser automatically any more. Instead the actual
`content.js`, `background.js`, and `offscreen.js` files were loaded unmodified
into a page with a `chrome.*` shim, and driven over the Chrome DevTools Protocol
with genuine double-click selections and button clicks. That covered:

- selection → card appears, anchored to the selection
- live lookups render correctly, including senses and sentence context
- the speaker button and every tier of its fallback chain
- Save writes a complete record to storage
- saving the same word twice is refused, and the stored count stays at 1
- clicks inside the card are ignored
- no page errors

**What this does not cover.** The Manifest V3 packaging layer — service worker
registration, real offscreen-document creation, and manifest-driven content
script injection — only exists in an installed extension. Load the extension and
try a few words to confirm that layer.

---

## 5. Known limitations

- Google Translate's public endpoint is undocumented and unversioned. It has
  been stable for years and is what browser translation extensions use, but
  Google could change or rate-limit it. That is exactly why the DeepL and
  MyMemory fallbacks were kept rather than deleted.
- Free Dictionary's audio host returns `502` for every word at the time of
  writing, so recorded human pronunciation is currently unavailable and the
  Google text-to-speech tier is doing the work. The speaker button still works.
- The IT glossary is hand-written, so it covers the terms it covers. Adding a
  term is one line in `background/glossary.js`.
