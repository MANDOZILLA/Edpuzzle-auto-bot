# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chrome extension (Manifest V3) that auto-answers EdPuzzle multiple-choice questions using AI via OpenRouter API. Plain JS, no build step.

## Loading & Testing

Load as unpacked extension at `chrome://extensions` (Developer mode). Reload button after code changes. Test on any edpuzzle.com assignment. Debug via DevTools Console — all logs prefixed with `[EPZ]` or `[EPZ-Injector]`.

## Architecture

Three execution contexts communicate via message passing:

```
Page World (injector.js)  ←postMessage→  Content Script (content.js)  ←chrome.runtime→  Service Worker (background.js)
```

### Page World — `injector.js`
- Injected at `document_start` via `inject-bootstrap.js` (5-line bootstrapper)
- Monkey-patches `window.fetch` and `XMLHttpRequest` to intercept EdPuzzle API responses
- Extracts question data from JSON responses (looks for objects with `data.type` and `data.body`)
- Handles answer clicking via React fiber internals (`__reactFiber$` props) — this MUST run in page world, not content script, because React internals aren't visible from the isolated world
- Listens for `EPZ_CLICK_ANSWER` and `EPZ_CLICK_SUBMIT` postMessages from content script

### Content Script — `content.js`
- Caches intercepted question data from injector
- Detects when a question is visible by matching page text against cached questions
- Delegates AI requests to background.js, click actions to injector.js
- Manages the floating badge (green=on, click to toggle), 2x playback speed, video resume

### Service Worker — `background.js`
- Handles OpenRouter API calls (avoids CORS issues content scripts would have)
- Cycles through multiple free models if one is rate-limited (429)
- Fatal errors (401/403) stop immediately; transient errors try next model

## EdPuzzle API Data Shape

Questions arrive as:
```
{ id, data: { type: "multiple-choice", body: { blocks: [{ value: "<p>HTML</p>" }] }, choices: [{ choiceId, content: { blocks: [{ value }] } }] } }
```

Key: `data.body.blocks[].value` = question HTML, `data.choices[].content.blocks[].value` = choice HTML. Answers are redacted (`isRedacted: true`), so AI is always needed.

## EdPuzzle DOM Selectors

Classes are obfuscated/random. Use `data-test-id` attributes:
- Answer choices: `[data-test-id*="multiple-choice-question-choice"]`
- Choice content (click target): `[data-test-id="choice-content"]`
- Answer text: `[data-test-id="rich-content-texts"]`

## React Click Handling

EdPuzzle uses React. Native `el.click()` and dispatched MouseEvents do NOT trigger React state changes. Must access React fiber via `__reactFiber$` or `__reactInternalInstance$` keys on DOM elements, walk up the fiber tree to find `memoizedProps.onClick`, and invoke it directly. This only works from page world context.

## Key Constraints

- MV3: no persistent background page, service worker only. Cannot read response bodies via `webRequest` API.
- `inject-bootstrap.js` must run at `document_start` to intercept API calls before they fire.
- `injector.js` must be in `web_accessible_resources` to be injectable.
- Free OpenRouter models change frequently — the model list in `background.js` may need updating.
