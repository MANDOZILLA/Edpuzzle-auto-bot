// Runs in page world — ONLY intercepts EdPuzzle API responses
(() => {
  const TAG = "[EPZ-Injector]";

  function isEdPuzzleQuestion(item) {
    return item && typeof item === "object" && item.data && item.data.type && item.data.body;
  }

  function findQuestions(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 8) return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && obj.some(isEdPuzzleQuestion)) return obj.filter(isEdPuzzleQuestion);
    }
    if (Array.isArray(obj.questions) && obj.questions.some(isEdPuzzleQuestion)) {
      return obj.questions.filter(isEdPuzzleQuestion);
    }
    for (const key of Object.keys(obj)) {
      if (key.startsWith("_")) continue;
      const result = findQuestions(obj[key], depth + 1);
      if (result) return result;
    }
    return null;
  }

  function postData(data) {
    try {
      const questions = findQuestions(data);
      if (questions && questions.length > 0) {
        window.postMessage({ type: "EPZ_API_DATA", questions }, "*");
        console.log(`${TAG} Captured ${questions.length} questions from API`);
      }
    } catch (e) {
      console.warn(`${TAG} Parse error:`, e);
    }
  }

  function isTargetURL(url) {
    if (!url || typeof url !== "string") return false;
    return (
      url.includes("/api/v3/") ||
      url.includes("/api/v4/") ||
      url.includes("/graphql") ||
      (url.includes("edpuzzle") && (url.includes("assignment") || url.includes("media") || url.includes("attempt")))
    );
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isTargetURL(url)) {
        const clone = response.clone();
        clone.json().then(postData).catch(() => {});
      }
    } catch {}
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._epzUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (isTargetURL(this._epzUrl) && this.responseText) {
          postData(JSON.parse(this.responseText));
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  // --- Check current state of a choice element ---
  function getCheckState(choiceEl) {
    var input = choiceEl.querySelector('input[type="checkbox"], input[type="radio"]');
    if (input) return input.checked;
    var aria = choiceEl.getAttribute('aria-checked');
    if (aria !== null) return aria === 'true';
    return /\b(selected|checked|active)\b/i.test(choiceEl.className || '');
  }

  // --- Native setter for React controlled inputs ---
  function nativeCheckboxToggle(el) {
    var cb = el.tagName === 'INPUT' ? el : el.querySelector('input[type="checkbox"], input[type="radio"]');
    if (!cb) return false;
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (descriptor && descriptor.set) {
      descriptor.set.call(cb, !cb.checked);
      cb.dispatchEvent(new Event('input', { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // --- React fiber click ---
  function reactClick(el) {
    // Strategy 1: React fiber onClick
    const fiberKey = Object.keys(el).find(k =>
      k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (fiberKey) {
      let fiber = el[fiberKey];
      let depth = 0;
      while (fiber && depth < 20) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        const handler = props.onClick || props.onChange || props.onMouseDown;
        if (typeof handler === "function") {
          console.log(`${TAG} React fiber handler found at depth ${depth}:`, fiber.type, el);
          var syntheticEvent = {
            type: "click",
            target: el,
            currentTarget: el,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            preventDefault: function() { this.defaultPrevented = true; },
            stopPropagation: function() {},
            nativeEvent: new MouseEvent("click", { bubbles: true }),
            persist: function() {},
            isDefaultPrevented: function() { return this.defaultPrevented; },
            isPropagationStopped: function() { return false; }
          };
          handler(syntheticEvent);
          nativeCheckboxToggle(el);
          return true;
        }
        fiber = fiber.return;
        depth++;
      }
      console.log(`${TAG} React fiber exists but no handler found after ${depth} levels`);
    } else {
      console.log(`${TAG} No React fiber on element`, el.tagName, el.className);
    }

    // Strategy 2: native checkbox setter (React controlled inputs)
    if (nativeCheckboxToggle(el)) {
      console.log(`${TAG} Native checkbox toggle applied on`, el.tagName);
    }

    // Strategy 3: direct .click()
    console.log(`${TAG} Trying direct .click() on`, el);
    el.click();

    // Strategy 4: full synthetic event sequence
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return true;
  }

  // --- Find choice elements using multiple selector strategies ---
  function findChoiceElements() {
    // Strategy 1: data-test-id selectors (exclude inner choice-content elements)
    const testIdStrategies = [
      '[data-test-id*="multiple-choice-question-choice"]',
      '[data-test-id*="choice"]:not([data-test-id="choice-content"])',
      '[data-test-id*="answer-choice"]',
      '[data-test-id*="option"]',
    ];
    for (const sel of testIdStrategies) {
      const els = document.querySelectorAll(sel);
      if (els.length >= 2) {
        console.log(`${TAG} Found ${els.length} choices with: ${sel}`);
        return els;
      }
    }

    // Strategy 2: checkboxes or radio inputs inside a question container
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length >= 2) {
      const wrappers = [];
      checkboxes.forEach(function(cb) {
        var wrapper = cb.closest('label') || cb.parentElement;
        wrappers.push(wrapper);
      });
      console.log(`${TAG} Found ${wrappers.length} choices via checkbox inputs`);
      return wrappers;
    }

    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length >= 2) {
      const wrappers = [];
      radios.forEach(function(rb) {
        var wrapper = rb.closest('label') || rb.parentElement;
        wrappers.push(wrapper);
      });
      console.log(`${TAG} Found ${wrappers.length} choices via radio inputs`);
      return wrappers;
    }

    // Strategy 3: role="checkbox" or role="radio" or role="option"
    var roleEls = document.querySelectorAll('[role="checkbox"], [role="radio"], [role="option"]');
    if (roleEls.length >= 2) {
      console.log(`${TAG} Found ${roleEls.length} choices via role attributes`);
      return roleEls;
    }

    // Strategy 4: scan for clickable containers with choice text
    // Look for repeated sibling elements that contain short text (likely choices)
    console.log(`${TAG} All strategies failed. Dumping page structure for debug:`);
    console.log(`${TAG}   data-test-id count: ${document.querySelectorAll('[data-test-id]').length}`);
    console.log(`${TAG}   checkboxes: ${checkboxes.length}, radios: ${radios.length}`);
    console.log(`${TAG}   role elements: ${roleEls.length}`);
    console.log(`${TAG}   buttons: ${document.querySelectorAll('button').length}`);
    var allDivs = document.querySelectorAll('div');
    console.log(`${TAG}   total divs: ${allDivs.length}`);

    return null;
  }

  function getElText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // --- Handle answer click request from content script ---
  function handleClickAnswer(answerText, allChoices) {
    let attempt = 0;
    const maxAttempts = 15;

    function tryClick() {
      attempt++;
      const choices = findChoiceElements();

      if (!choices) {
        if (attempt < maxAttempts) {
          setTimeout(tryClick, 500);
        } else {
          console.warn(`${TAG} No choice elements found after ${maxAttempts} attempts`);
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*");
        }
        return;
      }

      console.log(`${TAG} Click poll #${attempt}: ${choices.length} choices`);
      choices.forEach((c, i) => console.log(`${TAG}   Choice ${i}: "${getElText(c)}"`));

      const answerNorm = normalize(answerText);

      // Exact / substring match
      for (const choice of choices) {
        const ct = getElText(choice);
        if (ct === answerNorm || ct.includes(answerNorm) || answerNorm.includes(ct)) {
          console.log(`${TAG} Matched: "${ct}"`);
          const target = choice.querySelector('[data-test-id="choice-content"]') || choice;
          reactClick(target);
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
          return;
        }
      }

      // Fuzzy word match
      const words = answerNorm.split(" ").filter(w => w.length > 2);
      for (const choice of choices) {
        const ct = getElText(choice);
        const hits = words.filter(w => ct.includes(w)).length;
        if (words.length > 0 && hits / words.length >= 0.5) {
          console.log(`${TAG} Fuzzy matched: "${ct}" (${hits}/${words.length} words)`);
          const target = choice.querySelector('[data-test-id="choice-content"]') || choice;
          reactClick(target);
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
          return;
        }
      }

      // Index-based fallback: match by position if we know all choices
      if (allChoices && allChoices.length > 0) {
        const answerIdx = allChoices.findIndex(c => normalize(c) === answerNorm);
        if (answerIdx >= 0 && answerIdx < choices.length) {
          console.log(`${TAG} Index fallback: clicking choice ${answerIdx}`);
          const target = choices[answerIdx].querySelector('[data-test-id="choice-content"]') || choices[answerIdx];
          reactClick(target);
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
          return;
        }
      }

      if (attempt < maxAttempts) {
        setTimeout(tryClick, 500);
      } else {
        console.warn(`${TAG} Could not match "${answerText}" after ${maxAttempts} attempts`);
        window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*");
      }
    }

    tryClick();
  }

  // --- Find a button by text keywords ---
  function findButton(keywords) {
    // Try button text first (more reliable than data-test-id for action buttons)
    for (var b of document.querySelectorAll("button, a[role='button'], [role='button']")) {
      var text = normalize(b.textContent);
      for (var kw of keywords) {
        if (text.includes(kw) && !b.disabled) return b;
      }
    }
    // Fallback: data-test-id
    for (var kw of keywords) {
      var btn = document.querySelector('[data-test-id*="' + kw + '"]');
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  // --- Aggressively click a button ---
  function forceClickButton(btn) {
    console.warn(`${TAG} forceClickButton: "${btn.textContent.trim()}" tag=${btn.tagName}`);
    reactClick(btn);
    btn.click();
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    btn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // --- Handle submit click request ---
  function handleClickSubmit() {
    let attempt = 0;
    const maxAttempts = 10;

    function trySubmit() {
      attempt++;
      var btn = findButton(["submit", "check"]);

      // If no submit button, check if "Next question" is already showing (auto-graded correct)
      if (!btn) btn = findButton(["next question"]);

      if (btn) {
        console.log(`${TAG} Clicking submit (attempt ${attempt}): "${btn.textContent.trim()}"`);
        forceClickButton(btn);
        window.postMessage({ type: "EPZ_SUBMIT_RESULT", success: true }, "*");
        return;
      }

      if (attempt < maxAttempts) {
        setTimeout(trySubmit, 500);
      } else {
        console.warn(`${TAG} Submit not found after ${maxAttempts} attempts`);
        window.postMessage({ type: "EPZ_SUBMIT_RESULT", success: false }, "*");
      }
    }

    trySubmit();
  }

  // --- Handle continue click request ---
  function handleClickContinue() {
    let attempt = 0;
    const maxAttempts = 10;

    function tryContinue() {
      attempt++;
      // Only look for actual "next" buttons — never click "Rewatch"
      var btn = findButton(["next question", "continue", "siguiente"]);

      // Fallback: look for any button with "next" but NOT "rewatch"
      if (!btn) {
        for (var b of document.querySelectorAll("button")) {
          var text = normalize(b.textContent);
          if (text.includes("next") && !text.includes("rewatch") && !b.disabled) {
            btn = b;
            break;
          }
        }
      }

      if (btn) {
        console.log(`${TAG} Clicking continue (attempt ${attempt}): "${btn.textContent.trim()}"`);
        forceClickButton(btn);
        window.postMessage({ type: "EPZ_CONTINUE_RESULT", success: true }, "*");
        return;
      }

      if (attempt < maxAttempts) {
        setTimeout(tryContinue, 500);
      } else {
        console.warn(`${TAG} Continue not found after ${maxAttempts} attempts`);
        window.postMessage({ type: "EPZ_CONTINUE_RESULT", success: false }, "*");
      }
    }

    tryContinue();
  }

  // --- Click choice by index (brute-force mode) ---
  function handleClickByIndex(choiceIndex) {
    let attempt = 0;
    const maxAttempts = 15;

    function tryClick() {
      attempt++;
      const choices = findChoiceElements();

      if (!choices) {
        if (attempt < maxAttempts) {
          setTimeout(tryClick, 500);
        } else {
          console.warn(`${TAG} No choice elements found after ${maxAttempts} attempts`);
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*");
        }
        return;
      }

      if (choiceIndex >= choices.length) {
        console.warn(`${TAG} Choice index ${choiceIndex} out of bounds (${choices.length} choices)`);
        window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*");
        return;
      }

      var choice = choices[choiceIndex];
      console.warn(`${TAG} === CLICK DEBUG START ===`);
      console.warn(`${TAG} Clicking choice index ${choiceIndex} of ${choices.length}`);
      console.warn(`${TAG}   Element: ${choice.tagName} class="${(choice.className||'').substring(0,60)}" text="${getElText(choice).substring(0,30)}"`);
      console.warn(`${TAG}   outerHTML preview: ${choice.outerHTML.substring(0, 200)}`);

      // Try clicking the choice container
      reactClick(choice);

      // Strategy A: React controlled input — use native property setter
      var cb = choice.querySelector('input[type="checkbox"], input[type="radio"]');
      if (cb) {
        console.warn(`${TAG}   Found ${cb.type} input, using native setter`);
        var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
        if (descriptor && descriptor.set) {
          descriptor.set.call(cb, !cb.checked);
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          console.warn(`${TAG}   Native setter applied, checked=${cb.checked}`);
        }
      }

      // Strategy B: click inner choice-content target
      var inner = choice.querySelector('[data-test-id="choice-content"]');
      if (inner) { console.warn(`${TAG}   Also clicking choice-content`); reactClick(inner); }

      // Strategy C: walk ancestors for React handlers
      var parent = choice.parentElement;
      for (var i = 0; i < 5 && parent; i++) {
        var pFiber = Object.keys(parent).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (pFiber) {
          var f = parent[pFiber];
          while (f) {
            var props = f.memoizedProps || f.pendingProps || {};
            var h = props.onClick || props.onChange || props.onMouseDown;
            if (typeof h === 'function') {
              console.warn(`${TAG}   Found handler on ancestor ${i+1}: ${parent.tagName}.${(parent.className||'').substring(0,30)}`);
              h({ type: "click", target: choice, currentTarget: parent, bubbles: true, cancelable: true, defaultPrevented: false, preventDefault: function(){}, stopPropagation: function(){}, nativeEvent: new MouseEvent("click", {bubbles:true}), persist: function(){}, isDefaultPrevented: function(){return false}, isPropagationStopped: function(){return false} });
              break;
            }
            f = f.return;
          }
        }
        parent = parent.parentElement;
      }

      console.warn(`${TAG} === CLICK DEBUG END ===`);
      window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
    }

    tryClick();
  }

  // --- Multi-select: click combination of choices ---
  function handleClickMultiByIndices(choiceIndices, totalChoices) {
    var attempt = 0;
    var maxAttempts = 15;
    var selectedSet = {};
    choiceIndices.forEach(function(i) { selectedSet[i] = true; });

    function tryClick() {
      attempt++;
      var choices = findChoiceElements();

      if (!choices || choices.length < 2) {
        if (attempt < maxAttempts) { setTimeout(tryClick, 500); }
        else { window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*"); }
        return;
      }

      console.warn(`${TAG} Multi-select: setting indices [${choiceIndices}] of ${choices.length} choices`);

      var toggleQueue = [];
      for (var i = 0; i < choices.length; i++) {
        var isChecked = getCheckState(choices[i]);
        var shouldBeChecked = !!selectedSet[i];
        if (shouldBeChecked !== isChecked) {
          toggleQueue.push(i);
        }
      }

      if (toggleQueue.length === 0) {
        console.warn(`${TAG} All choices already in correct state`);
        window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
        return;
      }

      var idx = 0;
      function toggleNext() {
        if (idx >= toggleQueue.length) {
          window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
          return;
        }
        var ci = toggleQueue[idx];
        var choice = choices[ci];
        var action = selectedSet[ci] ? "Checking" : "Unchecking";
        console.warn(`${TAG}   ${action} index ${ci}: "${getElText(choice).substring(0, 30)}"`);
        reactClick(choice.querySelector('[data-test-id="choice-content"]') || choice);
        nativeCheckboxToggle(choice);
        idx++;
        setTimeout(toggleNext, 150);
      }
      toggleNext();
    }

    tryClick();
  }

  // --- Listen for click requests from content script ---
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "EPZ_CLICK_ANSWER") {
      if (event.data.choiceIndex !== undefined) {
        handleClickByIndex(event.data.choiceIndex);
      } else {
        handleClickAnswer(event.data.answerText, event.data.allChoices);
      }
    } else if (event.data?.type === "EPZ_CLICK_MULTI_ANSWER") {
      handleClickMultiByIndices(event.data.choiceIndices, event.data.totalChoices);
    } else if (event.data?.type === "EPZ_CLICK_SUBMIT") {
      handleClickSubmit();
    } else if (event.data?.type === "EPZ_CLICK_CONTINUE") {
      handleClickContinue();
    } else if (event.data?.type === "EPZ_DETECT_INPUT_TYPE") {
      var choices = findChoiceElements();
      var inputType = "unknown";
      if (choices && choices.length > 0) {
        var firstInput = choices[0].querySelector('input[type="checkbox"]');
        if (firstInput) { inputType = "checkbox"; }
        else {
          firstInput = choices[0].querySelector('input[type="radio"]');
          if (firstInput) { inputType = "radio"; }
        }
      }
      window.postMessage({ type: "EPZ_INPUT_TYPE_RESULT", inputType: inputType }, "*");
    }
  });

  console.log(`${TAG} Network interceptor + click handler installed`);
})();
