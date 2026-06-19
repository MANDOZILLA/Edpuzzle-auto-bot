import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

// Use ORIGINAL path (with spaces) — the real extension location
const extPath = "C:\\Users\\whyhe\\Downloads\\EdPuzzle Autonmous Bot";
const profile = join(tmpdir(), "epz-final-" + Date.now());
mkdirSync(profile, { recursive: true });

const port = 9222;
try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

console.log("Extension:", extPath);

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

await new Promise((r) => setTimeout(r, 3000));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

page.on("console", (m) => {
  if (m.text().includes("EPZ")) console.log(`[CONSOLE-EPZ] ${m.text()}`);
});

// Check all targets — list extension IDs
const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
console.log("\nAll targets BEFORE navigation:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

// Find our extension by checking which has background.js
const swTargets = targets.targetInfos.filter((t) => t.type === "service_worker");
for (const sw of swTargets) {
  if (sw.url.includes("background.js") || sw.url.includes("service_worker")) {
    console.log(`\nPotential our extension SW: ${sw.url}`);
  }
}

// Navigate to edpuzzle
console.log("\nNavigating to edpuzzle.com...");
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(5000);

// Thorough check
const diag = await page.evaluate(() => {
  return {
    badge: !!document.getElementById("epz-auto-badge"),
    epzCss: Array.from(document.styleSheets).some((s) => {
      try { return Array.from(s.cssRules || []).some((r) => r.selectorText?.includes("epz")); }
      catch { return false; }
    }),
    // Check for ANY chrome-extension stylesheet (content script CSS)
    chromeExtStyles: Array.from(document.querySelectorAll('link[href*="chrome-extension"]')).map(l => l.href),
    // Check injected styles
    injectedStyles: Array.from(document.querySelectorAll('style')).length,
    url: location.href,
    fetchStr: window.fetch.toString().substring(0, 120),
  };
});
console.log("\nDiagnostics:", JSON.stringify(diag, null, 2));

// Check targets again after navigation
const targets2 = await cdp.send("Target.getTargets");
console.log("\nAll targets AFTER navigation:");
targets2.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

// Try to get the extension ID and check its details
const extIds = new Set();
targets2.targetInfos.forEach((t) => {
  const match = t.url.match(/chrome-extension:\/\/([a-z]+)/);
  if (match) extIds.add(match[1]);
});
console.log("\nDetected extension IDs:", [...extIds]);

// For each extension, try to check if it has our manifest
for (const id of extIds) {
  try {
    const testPage = await context.newPage();
    await testPage.goto(`chrome-extension://${id}/manifest.json`, { timeout: 5000 });
    const text = await testPage.evaluate(() => document.body.innerText);
    const isOurs = text.includes("EdPuzzle");
    console.log(`  ${id}: ${isOurs ? "*** OUR EXTENSION ***" : "not ours"} — ${text.substring(0, 80)}`);
    await testPage.close();
  } catch (e) {
    console.log(`  ${id}: couldn't read manifest — ${e.message.substring(0, 60)}`);
  }
}

await browser.close();
chrome.kill();
console.log("\nDone");
