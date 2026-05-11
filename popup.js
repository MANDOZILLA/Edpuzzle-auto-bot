const toggle = document.getElementById("toggle");
const status = document.getElementById("status");

chrome.storage.local.get(["enabled", "apiKey"], (data) => {
  toggle.checked = data.enabled !== false;
  status.textContent = data.apiKey ? "API key set" : "No API key — go to settings";
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled });

  // Notify active edpuzzle tabs
  chrome.tabs.query({ url: "*://*.edpuzzle.com/*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE", enabled }).catch(() => {});
    }
  });
});

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
