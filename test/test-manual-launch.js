import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const extPath = "C:\\Users\\whyhe\\Downloads\\epz-ext-test";
const profile = join(tmpdir(), "epz-manual-" + Date.now());
mkdirSync(profile, { recursive: true });

const port = 9222;

// Kill any existing Chrome debug instances
try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

console.log("Launching Chrome manually...");
console.log("Extension:", extPath);
console.log("Profile:", profile);

const chrome = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: "ignore", detached: true }
);

// Wait for Chrome to start
await new Promise((r) => setTimeout(r, 3000));

console.log("Connecting via CDP...");
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
} catch (e) {
  console.error("Failed to connect:", e.message);
  chrome.kill();
  process.exit(1);
}

const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

const logs = [];
page.on("console", (m) => {
  logs.push(m.text());
  if (m.text().includes("EPZ")) console.log(`[EPZ] ${m.text()}`);
});

// Check extension targets via CDP
const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
const extTargets = targets.targetInfos.filter(
  (t) => t.type === "service_worker" || t.url.includes("chrome-extension")
);
console.log("\nExtension targets:", extTargets.length);
extTargets.forEach((t) => console.log("  ", t.type, t.url));

// Navigate to edpuzzle
console.log("\nNavigating to edpuzzle.com...");
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(4000);

const badge = await page.evaluate(() => !!document.getElementById("epz-auto-badge"));
const css = await page.evaluate(() =>
  Array.from(document.styleSheets).some((s) => {
    try { return Array.from(s.cssRules || []).some((r) => r.selectorText?.includes("epz-auto-badge")); }
    catch { return false; }
  })
);
const epzLogs = logs.filter((l) => l.includes("EPZ"));

console.log("\nBadge:", badge);
console.log("CSS loaded:", css);
console.log("EPZ logs:", epzLogs.length);
epzLogs.forEach((l) => console.log("  ", l));

// Recheck targets after navigation
const targets2 = await cdp.send("Target.getTargets");
const extTargets2 = targets2.targetInfos.filter(
  (t) => t.type === "service_worker" || t.url.includes("chrome-extension")
);
console.log("\nExtension targets after nav:", extTargets2.length);
extTargets2.forEach((t) => console.log("  ", t.type, t.url));

console.log("\nAll targets:");
targets2.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url.substring(0, 100)}`));

await browser.close();
chrome.kill();
console.log("\nDone");
