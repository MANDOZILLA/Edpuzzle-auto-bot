import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const extPath = "C:\\Users\\whyhe\\AppData\\Local\\Temp\\epz-clean";
const profile = join(tmpdir(), "epz-enable-" + Date.now());
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
    "--enable-extensions",
    `--load-extension=${extPath}`,
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

const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
console.log("\nAll targets:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

const hasBgJs = targets.targetInfos.some((t) => t.url.includes("background.js"));
console.log("\nOur extension service worker:", hasBgJs);

// Navigate to edpuzzle
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(5000);

const badge = await page.evaluate(() => !!document.getElementById("epz-auto-badge"));
console.log("Badge exists:", badge);

// Check targets after nav
const targets2 = await cdp.send("Target.getTargets");
const swList = targets2.targetInfos.filter(t => t.type === "service_worker");
console.log("\nService workers:", swList.map(t => t.url));

await browser.close();
chrome.kill();
console.log("Done");
