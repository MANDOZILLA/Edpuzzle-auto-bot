import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const testExtPath = "C:\\Users\\whyhe\\Downloads\\test-ext";
const epzExtPath = "C:\\Users\\whyhe\\AppData\\Local\\Temp\\epz-clean";
const profile = join(tmpdir(), "epz-minimal-" + Date.now());
mkdirSync(profile, { recursive: true });
const port = 9222;

try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

// Load BOTH extensions: minimal test + our real one
const extPaths = `${testExtPath},${epzExtPath}`;
console.log("Extension paths:", extPaths);

const chrome = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extPaths}`,
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

const allConsoleLogs = [];
page.on("console", (m) => {
  allConsoleLogs.push(m.text());
  if (m.text().includes("TEST-EXT") || m.text().includes("EPZ")) {
    console.log(`[CONSOLE] ${m.text()}`);
  }
});

// Check targets
const cdp = await context.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
console.log("\nAll targets:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

// Navigate to a simple page first
console.log("\nNavigating to example.com...");
await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(3000);

const hasRedBorder = await page.evaluate(() => document.body.style.border);
const testExtLogs = allConsoleLogs.filter((l) => l.includes("TEST-EXT"));
console.log("Red border (test ext):", hasRedBorder || "none");
console.log("TEST-EXT logs:", testExtLogs.length, testExtLogs);

// Navigate to edpuzzle
console.log("\nNavigating to edpuzzle.com...");
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(5000);

const badge = await page.evaluate(() => !!document.getElementById("epz-auto-badge"));
const epzLogs = allConsoleLogs.filter((l) => l.includes("EPZ"));
console.log("Badge:", badge);
console.log("EPZ logs:", epzLogs.length, epzLogs);

// Recheck targets
const targets2 = await cdp.send("Target.getTargets");
console.log("\nFinal targets:");
targets2.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url}`));

await browser.close();
chrome.kill();
console.log("Done");
