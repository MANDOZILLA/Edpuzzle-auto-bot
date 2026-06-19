import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, cpSync, rmSync, existsSync } from "fs";

// Clean copy WITHOUT test/, .git/, node_modules/ — just extension files
const cleanExt = join(tmpdir(), "epz-clean");
if (existsSync(cleanExt)) rmSync(cleanExt, { recursive: true });
mkdirSync(cleanExt, { recursive: true });

const src = "C:\\Users\\whyhe\\Downloads\\EdPuzzle Autonmous Bot";
const filesToCopy = [
  "manifest.json", "background.js", "content.js", "inject-bootstrap.js",
  "injector3.js", "popup.html", "popup.js", "settings.html", "settings.js",
  "styles.css",
];
for (const f of filesToCopy) {
  cpSync(join(src, f), join(cleanExt, f));
}
cpSync(join(src, "icons"), join(cleanExt, "icons"), { recursive: true });

console.log("Clean extension path:", cleanExt);

const profile = join(tmpdir(), "epz-clean-" + Date.now());
mkdirSync(profile, { recursive: true });
const port = 9222;

try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

const chrome = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${cleanExt}`,
    `--load-extension=${cleanExt}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: "ignore", detached: true }
);

await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

page.on("console", (m) => {
  if (m.text().includes("EPZ")) console.log(`[EPZ] ${m.text()}`);
});

// Check targets
const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
console.log("\nAll targets:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

// Check if any target has background.js (our extension)
const ourSW = targets.targetInfos.find((t) => t.url.includes("background.js"));
console.log("\nOur extension SW:", ourSW ? ourSW.url : "NOT FOUND");

// Try to read our extension's manifest via each extension ID
const extIds = new Set();
targets.targetInfos.forEach((t) => {
  const match = t.url.match(/chrome-extension:\/\/([a-z]+)/);
  if (match) extIds.add(match[1]);
});

for (const id of extIds) {
  try {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${id}/popup.html`, { timeout: 5000 });
    const text = await p.evaluate(() => document.title || document.body?.innerText?.substring(0, 100) || "empty");
    console.log(`  ${id}/popup.html: "${text}"`);
    await p.close();
  } catch (e) {
    console.log(`  ${id}: ${e.message.substring(0, 80)}`);
  }
}

// Navigate to edpuzzle and check
console.log("\nNavigating to edpuzzle.com...");
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(5000);

const badge = await page.evaluate(() => !!document.getElementById("epz-auto-badge"));
console.log("\nBadge exists:", badge);

// Recheck targets
const targets2 = await cdp.send("Target.getTargets");
const ourSW2 = targets2.targetInfos.find((t) => t.url.includes("background.js"));
console.log("Our SW after nav:", ourSW2 ? ourSW2.url : "NOT FOUND");

await browser.close();
chrome.kill();
console.log("\nDone");
