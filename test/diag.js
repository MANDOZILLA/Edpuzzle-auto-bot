import { chromium } from "playwright";
import { CONFIG } from "./config.js";
import { mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const freshProfile = join(tmpdir(), "epz-diag-" + Date.now());
mkdirSync(freshProfile, { recursive: true });

console.log("Extension path:", CONFIG.extensionPath);
console.log("Fresh profile:", freshProfile);

const context = await chromium.launchPersistentContext(freshProfile, {
  executablePath: CONFIG.chromePath,
  headless: false,
  args: [
    `--disable-extensions-except=${CONFIG.extensionPath}`,
    `--load-extension=${CONFIG.extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  viewport: { width: 1280, height: 800 },
});

const page = context.pages()[0] || await context.newPage();

const consoleLogs = [];
page.on("console", (msg) => {
  const text = msg.text();
  consoleLogs.push(text);
  if (text.includes("EPZ")) {
    console.log(`[CONSOLE] ${msg.type()}: ${text}`);
  }
});
page.on("pageerror", (err) => {
  console.log(`[ERROR] ${err.message}`);
});

// Step 1: Navigate to edpuzzle.com
console.log("\n--- Step 1: Navigate to edpuzzle.com ---");
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(3000);

// Check for content script
let diag1 = await page.evaluate(() => ({
  badge: !!document.getElementById("epz-auto-badge"),
  epzCss: Array.from(document.styleSheets).some(s => {
    try { return Array.from(s.cssRules || []).some(r => r.selectorText?.includes("epz-auto-badge")); }
    catch { return false; }
  }),
  url: location.href,
}));
console.log("Diagnostics on edpuzzle.com:", JSON.stringify(diag1, null, 2));

// Step 2: Check console for EPZ debug log
const epzLogs = consoleLogs.filter(l => l.includes("EPZ"));
console.log(`EPZ console logs so far: ${epzLogs.length}`);
epzLogs.forEach(l => console.log("  ", l));

// Step 3: Navigate to assignment
console.log("\n--- Step 2: Navigate to assignment ---");
await page.goto(CONFIG.scenarios[0].url, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(5000);

let diag2 = await page.evaluate(() => ({
  badge: !!document.getElementById("epz-auto-badge"),
  epzCss: Array.from(document.styleSheets).some(s => {
    try { return Array.from(s.cssRules || []).some(r => r.selectorText?.includes("epz-auto-badge")); }
    catch { return false; }
  }),
  fetchStr: window.fetch.toString().substring(0, 80),
  url: location.href,
}));
console.log("Diagnostics on assignment:", JSON.stringify(diag2, null, 2));

const epzLogs2 = consoleLogs.filter(l => l.includes("EPZ"));
console.log(`EPZ console logs total: ${epzLogs2.length}`);
epzLogs2.forEach(l => console.log("  ", l));

// Step 4: Try using CDP to check extension state
console.log("\n--- Step 3: CDP extension check ---");
try {
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send("Target.getTargets");
  const extTargets = targets.targetInfos.filter(t =>
    t.type === "service_worker" || t.url.includes("chrome-extension")
  );
  console.log("Extension-related targets:");
  extTargets.forEach(t => console.log(`  ${t.type}: ${t.url} (attached: ${t.attached})`));

  if (extTargets.length === 0) {
    console.log("  NONE — extension may not be loaded at all!");
  }
} catch (e) {
  console.log("CDP check failed:", e.message);
}

// Screenshot
mkdirSync(CONFIG.screenshotDir, { recursive: true });
await page.screenshot({ path: join(CONFIG.screenshotDir, "diag-final.png") });
console.log("\nScreenshot saved to screenshots/diag-final.png");

await context.close();
console.log("Done.");
