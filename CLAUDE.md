# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chrome extension (Manifest V3) that auto-answers EdPuzzle multiple-choice questions. Uses a brute-force strategy: clicks choices sequentially (first pass = top choice, second pass = second choice, etc.) until the correct answer is found. EdPuzzle replays the video for wrong answers within the same page load, so in-memory state persists. No build step — plain JS.

## Loading & Testing

Load as unpacked extension at `chrome://extensions` (Developer mode). After code changes: toggle extension off/on, then hard-refresh the EdPuzzle page (Chrome aggressively caches extension scripts). Debug via DevTools Console — logs prefixed `[EPZ]` (content script) or `[EPZ-Injector]` (page world).

**Cache gotcha**: Chrome caches `web_accessible_resources` files. If injector changes aren't taking effect, rename the file (e.g. `injector2.js` → `injector3.js`) and update `inject-bootstrap.js` + `manifest.json`.

## Architecture

Three execution contexts communicate via message passing:

```
Page World (injector2.js)  ←postMessage→  Content Script (content.js)  ←chrome.runtime→  Service Worker (background.js)
```

### Page World — `injector2.js`
- Injected at `document_start` via `inject-bootstrap.js` (bootstrapper)
- Monkey-patches `window.fetch` and `XMLHttpRequest` to intercept EdPuzzle API responses
- Extracts question data from JSON (objects with `data.type` and `data.body`)
- **All DOM clicking happens here** — React fiber internals (`__reactFiber$`) are only visible from page world
- Handles: `EPZ_CLICK_ANSWER` (by index or text), `EPZ_CLICK_SUBMIT`, `EPZ_CLICK_CONTINUE`
- `reactClick(el)`: walks React fiber tree for onClick/onChange handlers, falls back to `.click()` then full synthetic event sequence
- `findChoiceElements()`: multi-strategy selector cascade — `[data-test-id*="choice"]` is the one that currently works
- `findButton(keywords)`: finds submit/continue buttons by data-test-id then button text

### Content Script — `content.js`
- Caches intercepted question data from injector via `EPZ_API_DATA` postMessage
- Detects visible questions by matching page text against cached questions
- **Brute-force logic**: tracks `questionAttempts` Map (fingerprint → attempt count), clicks `choices[attemptCount]` each time a question appears
- Flow: click choice → 500ms → submit → 1000ms → continue/next → 500ms → resume video
- Persists attempts to `chrome.storage.local` scoped by URL path (cleared on init for fresh start)
- Manages floating badge (click to toggle on/off), 2x playback speed

### Service Worker — `background.js`
- OpenRouter API calls for AI-based answering (currently unused — brute-force mode doesn't call it)
- Still present; content.js never sends `ASK_AI` messages

### UI — `popup.js` / `settings.js`
- Popup: toggle on/off, link to settings
- Settings: save OpenRouter API key (only needed if AI mode is re-enabled)

## EdPuzzle API Data Shape

```js
{ id, data: { type: "multiple-choice", body: { blocks: [{ value: "<p>HTML</p>" }] }, choices: [{ choiceId, content: { blocks: [{ value }] } }] } }
```

Answers are always redacted (`isRedacted: true`).

## EdPuzzle DOM Selectors

Classes are obfuscated. Use `data-test-id` attributes:
- Answer choices: `[data-test-id*="choice"]` (elements like `data-test-id="choice-6..."`)
- Choice content inner target: `[data-test-id="choice-content"]`
- Submit/Continue buttons: found by button text content ("submit", "check", "continue", "next question")

## React Click Handling

EdPuzzle uses React. Native `.click()` and dispatched MouseEvents do NOT trigger React state changes. Must access React fiber via `__reactFiber$` or `__reactInternalInstance$` keys on DOM elements, walk up the fiber tree to find `memoizedProps.onClick`, and invoke directly. This only works from page world.

## Key Constraints

- MV3: no persistent background page. Cannot read response bodies via `webRequest` API.
- `inject-bootstrap.js` must run at `document_start` to intercept API calls before they fire.
- `injector2.js` must be in `web_accessible_resources`.
- EdPuzzle replays the video for wrong questions within the same page load (no navigation), so the brute-force Map persists in memory.
- Non-multiple-choice questions are skipped.
