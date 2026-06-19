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

  // --- Debug: dump React fiber handlers on a choice element ---
  function dumpHandlers(el) {
    console.warn(`${TAG} === FIBER HANDLER DEBUG ===`);
    function check(node, label) {
      if (!node) return;
      var fk = Object.keys(node).find(function(k) {
        return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
      });
      if (!fk) { console.warn(`${TAG}   ${label}: no fiber`); return; }
      var f = node[fk], d = 0;
      while (f && d < 12) {
        var p = f.memoizedProps || f.pendingProps || {};
        var h = Object.keys(p).filter(function(k) { return k.startsWith('on') && typeof p[k] === 'function'; });
        if (h.length) console.warn(`${TAG}   ${label} d${d} [${f.type||'?'}]: ${h.join(', ')}`);
        f = f.return; d++;
      }
    }
    check(el, 'choice');
    check(el.querySelector('[data-test-id="choice-content"]'), 'content');
    check(el.querySelector('input'), 'input');
    check(el.querySelector('label'), 'label');
    console.warn(`${TAG} === END FIBER DEBUG ===`);
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
          return true;
        }
        fiber = fiber.return;
        depth++;
      }
      console.log(`${TAG} React fiber exists but no handler found after ${depth} levels`);
    } else {
      console.log(`${TAG} No React fiber on element`, el.tagName, el.className);
    }

    // Strategy 2: direct .click()
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
    const maxAttempts = 15;

    function trySubmit() {
      attempt++;
      var btn = findButton(["submit", "check"]);

      // If no submit button, check if "Next question" or "Continue" is already showing
      if (!btn) btn = findButton(["next question", "continue", "siguiente"]);

      if (btn) {
        console.log(`${TAG} Clicking submit (attempt ${attempt}): "${btn.textContent.trim()}"`);
        forceClickButton(btn);
        window.postMessage({ type: "EPZ_SUBMIT_RESULT", success: true }, "*");
        return;
      }

      // Check for disabled submit — if present, answer might not have registered yet
      if (attempt >= 8) {
        for (var b of document.querySelectorAll("button")) {
          var text = normalize(b.textContent);
          if ((text.includes("submit") || text.includes("check")) && b.disabled) {
            console.warn(`${TAG} Submit found but DISABLED (attempt ${attempt}) — answer click may not have registered`);
            break;
          }
        }
      }

      if (attempt < maxAttempts) {
        setTimeout(trySubmit, 400);
      } else {
        console.warn(`${TAG} Submit not found/enabled after ${maxAttempts} attempts`);
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
      console.warn(`${TAG} Clicking choice ${choiceIndex}/${choices.length}: "${getElText(choice).substring(0,40)}"`);
      reactSetChecked(choice, true);
      window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
    }

    tryClick();
  }

  // --- Click a choice element to toggle selection ---
  function reactSetChecked(choiceEl, desiredChecked) {
    var input = choiceEl.querySelector('input[type="checkbox"], input[type="radio"]');

    if (!reactSetChecked._dbg) {
      reactSetChecked._dbg = true;
      dumpHandlers(choiceEl);
    }

    console.warn(`${TAG} ${desiredChecked ? 'Checking' : 'Unchecking'}: "${getElText(choiceEl).substring(0, 40)}"`);

    if (input) {
      // Strategy 0: Walk fiber tree from input looking for onToggle (EdPuzzle's handler)
      var fiberKey = Object.keys(input).find(function(k) {
        return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
      });
      if (fiberKey) {
        var fiber = input[fiberKey];
        var depth = 0;
        while (fiber && depth < 35) {
          var props = fiber.memoizedProps || fiber.pendingProps || {};
          if (typeof props.onToggle === 'function') {
            console.warn(`${TAG} Calling onToggle at depth ${depth}`);
            try { props.onToggle(); } catch(e) { console.warn(`${TAG} onToggle threw:`, e); }
            console.warn(`${TAG} After onToggle → checked=${input.checked}`);
            return;
          }
          fiber = fiber.return;
          depth++;
        }
      }

      // Strategy 1: Directly invoke React fiber onChange on the input element.
      // React-controlled checkboxes call preventDefault() on native clicks,
      // so input.click() never toggles checked. We must call onChange ourselves.
      if (fiberKey) {
        var fiber = input[fiberKey];
        var depth = 0;
        while (fiber && depth < 35) {
          var props = fiber.memoizedProps || fiber.pendingProps || {};
          if (typeof props.onChange === 'function') {
            var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
            nativeSetter.call(input, desiredChecked);
            console.warn(`${TAG} Calling fiber onChange at depth ${depth}, target.checked=${input.checked}`);
            try {
              props.onChange({
                type: 'change',
                target: input,
                currentTarget: input,
                bubbles: true,
                cancelable: true,
                defaultPrevented: false,
                preventDefault: function() {},
                stopPropagation: function() {},
                persist: function() {},
                nativeEvent: new Event('change', { bubbles: true }),
                isDefaultPrevented: function() { return false; },
                isPropagationStopped: function() { return false; }
              });
            } catch(e) {
              console.warn(`${TAG} fiber onChange threw:`, e);
            }
            console.warn(`${TAG} After fiber onChange → checked=${input.checked}`);
            return;
          }
          fiber = fiber.return;
          depth++;
        }
      }

      // Strategy 2: Reset React's internal value tracker so it detects the change,
      // then set checked via native setter and dispatch events
      var tracker = input._valueTracker;
      if (tracker) tracker.setValue(String(!desiredChecked));
      var nativeSetter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
      nativeSetter2.call(input, desiredChecked);
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      console.warn(`${TAG} valueTracker reset + events → checked=${input.checked}`);
      if (input.checked === desiredChecked) return;

      // Strategy 3: Plain input.click()
      input.click();
      console.warn(`${TAG} input.click() → checked=${input.checked}`);
      if (input.checked === desiredChecked) return;
    }

    // Strategy 4: Walk fiber from choiceEl for onToggle (broader search)
    var choiceFiberKey = Object.keys(choiceEl).find(function(k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    if (choiceFiberKey) {
      var fiber = choiceEl[choiceFiberKey];
      var depth = 0;
      while (fiber && depth < 35) {
        var props = fiber.memoizedProps || fiber.pendingProps || {};
        if (typeof props.onToggle === 'function') {
          console.warn(`${TAG} choiceEl onToggle at depth ${depth}`);
          try { props.onToggle(); } catch(e) {}
          console.warn(`${TAG} After choiceEl onToggle → checked=${input ? input.checked : 'no-input'}`);
          return;
        }
        fiber = fiber.return;
        depth++;
      }
    }

    // Strategy 5: Click label
    var label = choiceEl.querySelector('label');
    if (label) {
      label.click();
      console.warn(`${TAG} label.click() → checked=${input ? input.checked : 'no-input'}`);
      if (input && input.checked === desiredChecked) return;
    }

    // Strategy 6: reactClick on container
    var target = choiceEl.querySelector('[data-test-id="choice-content"]') || choiceEl;
    reactClick(target);
    console.warn(`${TAG} reactClick fallback → checked=${input ? input.checked : 'no-input'}`);
  }

  // --- Multi-select: click combination of choices ---
  function handleClickMultiByIndices(choiceIndices, totalChoices) {
    var attempt = 0;
    var maxAttempts = 15;

    function tryClick() {
      attempt++;
      var choices = findChoiceElements();

      if (!choices || choices.length < 2) {
        if (attempt < maxAttempts) { setTimeout(tryClick, 500); }
        else { window.postMessage({ type: "EPZ_CLICK_RESULT", success: false }, "*"); }
        return;
      }

      console.warn(`${TAG} Multi-select: clicking indices [${choiceIndices}] of ${choices.length} choices`);

      // Just click desired indices — don't check input.checked (unreliable due to
      // prior native setter desync). Questions appear fresh each time after replay.
      var idx = 0;
      function clickNext() {
        if (idx >= choiceIndices.length) {
          setTimeout(function() {
            window.postMessage({ type: "EPZ_CLICK_RESULT", success: true }, "*");
          }, 400);
          return;
        }
        var ci = choiceIndices[idx];
        if (ci >= choices.length) { idx++; clickNext(); return; }
        reactSetChecked(choices[ci], true);
        idx++;
        setTimeout(clickNext, 300);
      }
      clickNext();
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
