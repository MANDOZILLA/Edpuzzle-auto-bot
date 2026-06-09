(() => {
  const TAG = "[EPZ]";
  let enabled = true;
  let processing = false;
  let badge = null;
  let cachedQuestions = [];
  let questionAttempts = new Map();
  let lastAnsweredFingerprint = null;

  chrome.storage.local.get("enabled", (data) => {
    enabled = data.enabled !== false;
    updateBadge();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE") {
      enabled = msg.enabled;
      updateBadge();
    }
  });

  // --- EdPuzzle data helpers ---
  function blocksToText(blockContainer) {
    if (!blockContainer || !blockContainer.blocks) return "";
    return blockContainer.blocks
      .map(b => stripHTML(b.value || ""))
      .join(" ")
      .trim();
  }

  function getQuestionText(q) {
    return blocksToText(q.data?.body) || "";
  }

  function getQuestionType(q) {
    return q.data?.type || "";
  }

  function getChoices(q) {
    return (q.data?.choices || []).map(c => ({
      id: c.choiceId,
      text: blocksToText(c.content) || ""
    }));
  }

  // --- Listen for intercepted API data ---
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "EPZ_API_DATA") return;
    const questions = event.data.questions;
    if (questions && questions.length > 0) {
      cachedQuestions = questions;
      console.log(`${TAG} Cached ${questions.length} questions from API`);
      questions.forEach((q, i) => {
        const qText = getQuestionText(q) || "(empty)";
        const type = getQuestionType(q);
        const choices = getChoices(q);
        console.log(`${TAG}  Q${i + 1} [${type}]: "${qText.substring(0, 60)}" (${choices.length} choices)`);
      });
    }
  });

  // --- Badge ---
  function createBadge() {
    badge = document.createElement("div");
    badge.id = "epz-auto-badge";
    badge.textContent = "EPZ";
    badge.addEventListener("click", () => {
      enabled = !enabled;
      chrome.storage.local.set({ enabled });
      updateBadge();
    });
    document.body.appendChild(badge);
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    badge.classList.toggle("epz-active", enabled);
    badge.classList.toggle("epz-inactive", !enabled);
    badge.title = enabled ? "Auto-answer ON" : "Auto-answer OFF";
  }

  // --- Speed ---
  function setPlaybackSpeed() {
    const video = document.querySelector("video");
    if (video && video.playbackRate !== 2) {
      video.playbackRate = 2;
      console.log(`${TAG} Playback set to 2x`);
    }
  }

  // --- Text helpers ---
  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function stripHTML(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
  }
  function stripParens(text) {
    return text.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  function textsMatch(a, b) {
    if (!a || !b) return false;
    const na = normalize(a), nb = normalize(b);
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const sa = stripParens(na), sb = stripParens(nb);
    if (sa === sb || sa.includes(sb) || sb.includes(sa)) return true;
    return false;
  }
  function getElementText(el) {
    return (el.innerText || el.textContent || "").trim();
  }

  // --- Combination generator for multi-select brute-force ---
  function generateCombinations(n) {
    const results = [];
    for (let size = 1; size <= n; size++) {
      (function combo(start, current) {
        if (current.length === size) { results.push([...current]); return; }
        for (let i = start; i < n; i++) { current.push(i); combo(i + 1, current); current.pop(); }
      })(0, []);
    }
    return results;
  }

  // --- Detect input type (checkbox=multi, radio=single) ---
  function detectInputType() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { window.removeEventListener("message", handler); resolve("unknown"); }, 5000);
      function handler(event) {
        if (event.source !== window || event.data?.type !== "EPZ_INPUT_TYPE_RESULT") return;
        window.removeEventListener("message", handler);
        clearTimeout(timeout);
        resolve(event.data.inputType);
      }
      window.addEventListener("message", handler);
      window.postMessage({ type: "EPZ_DETECT_INPUT_TYPE" }, "*");
    });
  }

  // --- Find which cached question is currently visible ---
  function findCurrentQuestion() {
    const bodyText = normalize(document.body.innerText);
    for (const q of cachedQuestions) {
      const qText = normalize(getQuestionText(q));
      if (!qText || qText.length < 3) continue;
      if (bodyText.includes(qText)) {
        const choices = getChoices(q);
        if (choices.some(c => bodyText.includes(normalize(c.text)))) return q;
      }
    }
    return null;
  }

  // --- Delegate click to page world (injector.js) via postMessage ---
  function pollAndClickAnswer(choiceIndex) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        console.warn(`${TAG} Click answer timed out`);
        resolve(false);
      }, 10000);

      function handler(event) {
        if (event.source !== window || event.data?.type !== "EPZ_CLICK_RESULT") return;
        window.removeEventListener("message", handler);
        clearTimeout(timeout);
        console.log(`${TAG} Click result: ${event.data.success}`);
        resolve(event.data.success);
      }

      window.addEventListener("message", handler);
      window.postMessage({ type: "EPZ_CLICK_ANSWER", choiceIndex }, "*");
    });
  }

  function pollAndClickMultiAnswer(choiceIndices, totalChoices) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { window.removeEventListener("message", handler); resolve(false); }, 10000);
      function handler(event) {
        if (event.source !== window || event.data?.type !== "EPZ_CLICK_RESULT") return;
        window.removeEventListener("message", handler);
        clearTimeout(timeout);
        resolve(event.data.success);
      }
      window.addEventListener("message", handler);
      window.postMessage({ type: "EPZ_CLICK_MULTI_ANSWER", choiceIndices, totalChoices }, "*");
    });
  }

  function pollAndClickSubmit() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        console.warn(`${TAG} Submit timed out`);
        resolve(false);
      }, 8000);

      function handler(event) {
        if (event.source !== window || event.data?.type !== "EPZ_SUBMIT_RESULT") return;
        window.removeEventListener("message", handler);
        clearTimeout(timeout);
        console.log(`${TAG} Submit result: ${event.data.success}`);
        resolve(event.data.success);
      }

      window.addEventListener("message", handler);
      window.postMessage({ type: "EPZ_CLICK_SUBMIT" }, "*");
    });
  }

  function pollAndClickContinue() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        console.warn(`${TAG} Continue timed out`);
        resolve(false);
      }, 8000);

      function handler(event) {
        if (event.source !== window || event.data?.type !== "EPZ_CONTINUE_RESULT") return;
        window.removeEventListener("message", handler);
        clearTimeout(timeout);
        console.log(`${TAG} Continue result: ${event.data.success}`);
        resolve(event.data.success);
      }

      window.addEventListener("message", handler);
      window.postMessage({ type: "EPZ_CLICK_CONTINUE" }, "*");
    });
  }

  // --- Resume video ---
  function resumeVideo() {
    const video = document.querySelector("video");
    if (video && video.paused) {
      video.play().catch(() => {});
      setPlaybackSpeed();
    }
  }

  // --- Sleep helper ---
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // --- Persistence helpers ---
  function getAssignmentKey() {
    return "epz_attempts_" + location.pathname.replace(/[^a-zA-Z0-9]/g, "_");
  }

  function persistAttempts() {
    const obj = Object.fromEntries(questionAttempts);
    chrome.storage.local.set({ [getAssignmentKey()]: obj });
  }

  function restoreAttempts() {
    const key = getAssignmentKey();
    chrome.storage.local.get(key, (data) => {
      if (data[key]) {
        questionAttempts = new Map(Object.entries(data[key]).map(([k, v]) => [k, Number(v)]));
        console.log(`${TAG} Restored ${questionAttempts.size} attempt records`);
      }
    });
  }

  // --- Main question handler (brute-force) ---
  async function handleQuestion() {
    if (!enabled || processing || cachedQuestions.length === 0) return;

    const matched = findCurrentQuestion();
    if (!matched) {
      lastAnsweredFingerprint = null;
      return;
    }

    const questionText = getQuestionText(matched);
    const type = getQuestionType(matched);
    const fingerprint = matched.id || normalize(questionText).substring(0, 50);

    if (fingerprint === lastAnsweredFingerprint) return;

    if (type !== "multiple-choice") {
      console.log(`${TAG} Non-MC question "${type}", skipping.`);
      lastAnsweredFingerprint = fingerprint;
      return;
    }

    const choices = getChoices(matched);
    if (choices.length < 2) return;

    const attemptCount = questionAttempts.get(fingerprint) || 0;

    processing = true;

    try {
      const inputType = await detectInputType();
      const isMultiSelect = inputType === "checkbox";

      const choiceTexts = choices.map(c => c.text);
      let maxAttempts, currentCombo;

      if (isMultiSelect) {
        const allCombos = generateCombinations(choices.length);
        maxAttempts = allCombos.length;
        currentCombo = allCombos[attemptCount];
      } else {
        maxAttempts = choices.length;
        currentCombo = null;
      }

      if (attemptCount >= maxAttempts) {
        console.warn(`${TAG} All ${maxAttempts} ${isMultiSelect ? "combos" : "choices"} exhausted for: "${questionText}"`);
        lastAnsweredFingerprint = fingerprint;
        processing = false;
        return;
      }

      console.log(`${TAG} Question: "${questionText}"`);
      console.log(`${TAG} Choices: ${choiceTexts.join(" | ")}`);

      let clicked;
      if (isMultiSelect) {
        console.log(`${TAG} Multi-select attempt ${attemptCount + 1}/${maxAttempts}: indices [${currentCombo}] = ${currentCombo.map(i => choiceTexts[i]).join(" + ")}`);
        await sleep(300);
        clicked = await pollAndClickMultiAnswer(currentCombo, choices.length);
      } else {
        console.log(`${TAG} Attempt ${attemptCount + 1}/${maxAttempts}: clicking choice index ${attemptCount} ("${choiceTexts[attemptCount]}")`);
        await sleep(300);
        clicked = await pollAndClickAnswer(attemptCount);
      }

      if (clicked) {
        await sleep(500);
        const submitted = await pollAndClickSubmit();
        questionAttempts.set(fingerprint, attemptCount + 1);
        persistAttempts();
        await sleep(1500);
        const continued = await pollAndClickContinue();
        if (!continued) {
          console.log(`${TAG} No continue/next button — resuming video for replay`);
        }
        await sleep(500);
        resumeVideo();
      }

      lastAnsweredFingerprint = fingerprint;
      processing = false;
    } catch (err) {
      console.error(`${TAG} Error:`, err);
      processing = false;
    }
  }

  // --- Watchers ---
  function startWatching() {
    const observer = new MutationObserver(() => {
      if (enabled && !processing) handleQuestion();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function watchVideo() {
      const video = document.querySelector("video");
      if (video) {
        video.addEventListener("pause", () => {
          if (enabled && !processing) {
            setTimeout(handleQuestion, 800);
          }
        });
        setPlaybackSpeed();
        console.log(`${TAG} Video pause listener attached`);
      } else {
        setTimeout(watchVideo, 1000);
      }
    }
    watchVideo();

    setInterval(() => {
      if (enabled && !processing) {
        handleQuestion();
        setPlaybackSpeed();
      }
    }, 4000);
  }

  // --- Init ---
  function init() {
    createBadge();
    setPlaybackSpeed();
    restoreAttempts();
    startWatching();
    questionAttempts = new Map();
    chrome.storage.local.get(null, function(all) {
      var keys = Object.keys(all).filter(function(k) { return k.startsWith("epz_attempts_"); });
      if (keys.length) chrome.storage.local.remove(keys);
    });
    console.log(`${TAG} EdPuzzle Auto Answerer v2 (brute-force mode) loaded`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
