const input = document.getElementById("apiKey");
const msg = document.getElementById("msg");

chrome.storage.local.get("apiKey", (data) => {
  if (data.apiKey) input.value = data.apiKey;
});

document.getElementById("save").addEventListener("click", () => {
  const key = input.value.trim();
  if (!key) {
    msg.textContent = "Please enter an API key.";
    msg.style.color = "#ef4444";
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    msg.textContent = "Saved!";
    msg.style.color = "#22c55e";
  });
});
