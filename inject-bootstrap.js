// Runs at document_start to inject page-world script before any API calls fire
const s = document.createElement("script");
s.src = chrome.runtime.getURL("injector.js");
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);
