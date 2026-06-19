import { chromium } from "playwright";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const extPath = "C:\\Users\\whyhe\\Downloads\\epz-ext-test";
const profile = join(tmpdir(), "epz-bare-" + Date.now());
mkdirSync(profile, { recursive: true });

console.log("Ext path:", extPath);

// Ignore ALL default args to eliminate interference
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: false,
  ignoreAllDefaultArgs: true,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
  ],
  viewport: { width: 1280, height: 800 },
});

const page = ctx.pages()[0] || await ctx.newPage();
const logs = [];
page.on("console", (m) => {
  logs.push(m.text());
  if (m.text().includes("EPZ")) console.log(`[EPZ] ${m.text()}`);
});

// Navigate to chrome://version to see actual args
try {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Page.navigate", { url: "chrome://version" });
  await page.waitForTimeout(3000);
  const cmdLine = await page.evaluate(() => {
    const el = document.getElementById("command_line");
    return el ? el.textContent : "not found";
  });
  console.log("\nActual command line:\n", cmdLine?.substring(0, 500));
} catch (e) {
  console.log("chrome://version failed:", e.message);
}

// Now navigate to edpuzzle
await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(4000);

const badge = await page.evaluate(() => !!document.getElementById("epz-auto-badge"));
const epzLogs = logs.filter((l) => l.includes("EPZ"));
console.log("\nBadge:", badge);
console.log("EPZ logs:", epzLogs.length);
epzLogs.forEach((l) => console.log("  ", l));

// CDP target check
try {
  const cdp2 = await ctx.newCDPSession(page);
  const targets = await cdp2.send("Target.getTargets");
  const extTargets = targets.targetInfos.filter(
    (t) => t.type === "service_worker" || t.url.includes("chrome-extension")
  );
  console.log("Extension targets:", extTargets.length);
  extTargets.forEach((t) => console.log("  ", t.type, t.url));
} catch (e) {
  console.log("CDP check failed:", e.message);
}

await ctx.close();
console.log("Done");
