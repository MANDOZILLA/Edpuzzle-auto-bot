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

  console.log(`${TAG} Network interceptor installed`);
})();
