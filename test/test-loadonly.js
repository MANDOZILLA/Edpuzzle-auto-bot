import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const extPath = "C:\\Users\\whyhe\\AppData\\Local\\Temp\\epz-clean";
const profile = join(tmpdir(), "epz-loadonly-" + Date.now());
mkdirSync(profile, { recursive: true });
const port = 9222;

try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

console.log("Extension:", extPath);

// Try 1: Just --load-extension, no --disable-extensions-except
const chrome = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: "pipe", detached: true }
);

// Capture Chrome stderr for extension loading errors
chrome.stderr?.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log("[CHROME STDERR]", s);
});

await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

page.on("console", (m) => {
  if (m.text().includes("EPZ")) console.log(`[EPZ] ${m.text()}`);
});

const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
console.log("\nAll targets:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

const hasBgJs = targets.targetInfos.some((t) => t.url.includes("background.js"));
console.log("\nOur extension loaded:", hasBgJs);

// Also navigate to chrome://extensions to see
try {
  await cdp.send("Page.navigate", { url: "chrome://extensions" });
  await page.waitForTimeout(3000);

  // Try to get extension list from the page
  const extInfo = await page.evaluate(() => {
    // chrome://extensions uses shadow DOM
    const manager = document.querySelector("extensions-manager");
    if (!manager) return "no extensions-manager found";
    const sr = manager.shadowRoot;
    if (!sr) return "no shadow root";
    const list = sr.querySelector("extensions-item-list");
    if (!list) return "no item list";
    const items = list.shadowRoot?.querySelectorAll("extensions-item");
    if (!items) return "no items";
    return Array.from(items).map((item) => {
      const sr2 = item.shadowRoot;
      const name = sr2?.querySelector("#name")?.textContent;
      const id = item.id;
      return `${name} (${id})`;
    });
  });
  console.log("\nExtensions page:", extInfo);
} catch (e) {
  console.log("chrome://extensions failed:", e.message.substring(0, 100));
}

// Navigate to edpuzzle
console.log("\nNavigating to edpuzzle.com...");
const page2 = await context.newPage();
page2.on("console", (m) => {
  if (m.text().includes("EPZ")) console.log(`[EPZ] ${m.text()}`);
});
await page2.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page2.waitForTimeout(5000);

const badge = await page2.evaluate(() => !!document.getElementById("epz-auto-badge"));
console.log("Badge exists:", badge);

await browser.close();
chrome.kill();
console.log("Done");
