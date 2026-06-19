import { chromium } from "playwright";
import { CONFIG } from "./config.js";

console.log("Extension path:", CONFIG.extensionPath);
console.log("Chrome path:", CONFIG.chromePath);

const ctx = await chromium.launchPersistentContext(CONFIG.userDataDir, {
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

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto("about:blank");
console.log("Chrome launched with extension loaded");
await page.waitForTimeout(3000);
await ctx.close();
console.log("Smoke test passed");
