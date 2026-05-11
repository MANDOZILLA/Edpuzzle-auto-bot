(() => {
  const TAG = "[EPZ]";
  let enabled = true;
  let processing = false;
  let badge = null;
  let cachedQuestions = [];
  let answeredQuestions = new Set();

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

  // --- Poll for choice elements and click the matching one ---
  function pollAndClickAnswer(answerText, maxAttempts = 12) {
    return new Promise((resolve) => {
      let attempt = 0;

      function tryClick() {
        attempt++;
        const choices = document.querySelectorAll('[data-test-id*="multiple-choice-question-choice"]');
        console.log(`${TAG} Click poll #${attempt}: ${choices.length} choices in DOM`);

        if (choices.length === 0) {
          if (attempt < maxAttempts) {
            setTimeout(tryClick, 500);
          } else {
            console.warn(`${TAG} No choice elements found after ${maxAttempts} attempts`);
            resolve(false);
          }
          return;
        }

        // Log all choice texts
        choices.forEach((c, i) => {
          console.log(`${TAG}   Choice ${i}: "${getElementText(c)}"`);
        });

        // Try to match
        for (const choice of choices) {
          const choiceText = getElementText(choice);
          if (textsMatch(choiceText, answerText)) {
            console.log(`${TAG} Matched: "${choiceText}"`);
            const target = choice.querySelector('[data-test-id="choice-content"]') || choice;
            simulateClick(target);
            resolve(true);
            return;
          }
        }

        // Fuzzy word match as fallback
        for (const choice of choices) {
          const choiceText = normalize(getElementText(choice));
          const words = normalize(answerText).split(" ").filter(w => w.length > 2);
          const hits = words.filter(w => choiceText.includes(w)).length;
          if (words.length > 0 && hits / words.length >= 0.5) {
            console.log(`${TAG} Fuzzy matched: "${choiceText}" (${hits}/${words.length} words)`);
            const target = choice.querySelector('[data-test-id="choice-content"]') || choice;
            simulateClick(target);
            resolve(true);
            return;
          }
        }

        // No match yet — choices may still be loading text
        if (attempt < maxAttempts) {
          setTimeout(tryClick, 500);
        } else {
          console.warn(`${TAG} Could not match "${answerText}" after ${maxAttempts} attempts`);
          resolve(false);
        }
      }

      tryClick();
    });
  }

  // --- Poll for submit button and click it ---
  function pollAndClickSubmit(maxAttempts = 8) {
    return new Promise((resolve) => {
      let attempt = 0;

      function trySubmit() {
        attempt++;

        // Try data-test-id
        let btn = document.querySelector('[data-test-id*="submit"], [data-test-id*="check-answer"]');

        // Try by text
        if (!btn || btn.disabled) {
          btn = null;
          for (const b of document.querySelectorAll("button")) {
            const text = normalize(b.textContent);
            if ((text.includes("submit") || text.includes("check")) && !b.disabled) {
              btn = b;
              break;
            }
          }
        }

        if (btn && !btn.disabled) {
          console.log(`${TAG} Clicking submit (attempt ${attempt})`);
          simulateClick(btn);
          resolve(true);
          return;
        }

        if (attempt < maxAttempts) {
          setTimeout(trySubmit, 500);
        } else {
          console.warn(`${TAG} Submit not found after ${maxAttempts} attempts`);
          resolve(false);
        }
      }

      trySubmit();
    });
  }

  // --- Simulate click with full event sequence ---
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };

    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
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

  // --- Main question handler ---
  async function handleQuestion() {
    if (!enabled || processing || cachedQuestions.length === 0) return;

    const matched = findCurrentQuestion();
    if (!matched) return;

    const questionText = getQuestionText(matched);
    const type = getQuestionType(matched);
    const fingerprint = matched.id || normalize(questionText).substring(0, 50);

    if (answeredQuestions.has(fingerprint)) return;

    if (type !== "multiple-choice") {
      console.log(`${TAG} Non-MC question "${type}", skipping.`);
      answeredQuestions.add(fingerprint);
      return;
    }

    const choices = getChoices(matched);
    if (choices.length < 2) return;

    processing = true;
    answeredQuestions.add(fingerprint);

    const choiceTexts = choices.map(c => c.text);
    console.log(`${TAG} Question: "${questionText}"`);
    console.log(`${TAG} Choices: ${choiceTexts.join(" | ")}`);
    console.log(`${TAG} Asking AI...`);

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "ASK_AI", question: questionText, choices: choiceTexts },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp || { error: "No response from background" });
            }
          }
        );
      });

      if (response.error) {
        console.error(`${TAG} AI error: ${response.error}`);
        processing = false;
        return;
      }

      const answerText = choiceTexts[response.answerIndex];
      console.log(`${TAG} AI picked choice ${response.answerIndex + 1}: "${answerText}"`);

      // Wait a moment for UI to be ready, then poll and click
      await sleep(500);
      const clicked = await pollAndClickAnswer(answerText);

      if (clicked) {
        await sleep(1000);
        await pollAndClickSubmit();
        await sleep(2000);
        resumeVideo();
      }

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
    startWatching();
    console.log(`${TAG} EdPuzzle Auto Answerer v2 loaded`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
