import { chromium } from "playwright";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const extPath = "C:\\Users\\whyhe\\Downloads\\epz-ext-test";
const profile = join(tmpdir(), "epz-override-" + Date.now());
mkdirSync(profile, { recursive: true });

console.log("Ext path:", extPath);

// Prevent Playwright from adding --disable-extensions
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  viewport: { width: 1280, height: 800 },
});

const page = ctx.pages()[0] || await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));

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

console.log("Badge:", badge);
console.log("CSS loaded:", css);
console.log("EPZ logs:", epzLogs.length);
epzLogs.forEach((l) => console.log("  ", l));

const cdp = await ctx.newCDPSession(page);
const targets = await cdp.send("Target.getTargets");
const extTargets = targets.targetInfos.filter(
  (t) => t.type === "service_worker" || t.url.includes("chrome-extension")
);
console.log("Extension targets:", extTargets.length);
extTargets.forEach((t) => console.log("  ", t.type, t.url));

// Also check ALL targets to see if anything extension-related appears
console.log("\nAll browser targets:");
targets.targetInfos.forEach((t) => console.log(`  ${t.type}: ${t.url.substring(0, 80)}`));

await ctx.close();
console.log("Done");
