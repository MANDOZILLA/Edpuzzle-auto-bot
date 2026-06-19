import { chromium } from "playwright";
import { CONFIG } from "./config.js";
import { mkdirSync, createWriteStream, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(CONFIG.screenshotDir, { recursive: true });
mkdirSync(CONFIG.logDir, { recursive: true });

const injectorCode = readFileSync(resolve(CONFIG.extensionPath, "injector3.js"), "utf-8");
const stylesCode = readFileSync(resolve(CONFIG.extensionPath, "styles.css"), "utf-8");

const allLogs = [];
const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logStream = createWriteStream(join(CONFIG.logDir, `run-${runTimestamp}.txt`));

function captureLog(source, type, text) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${source}] [${type}] ${text}`;
  if (text.includes("[EPZ-Injector]")) {
    process.stdout.write(`\x1b[36m${line}\x1b[0m\n`);
  } else if (text.includes("[EPZ]")) {
    process.stdout.write(`\x1b[32m${line}\x1b[0m\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  logStream.write(line + "\n");
  allLogs.push({ timestamp, source, type, text });
}

async function screenshot(page, scenario, label) {
  const filename = `${scenario.name}-${label}.png`;
  const filepath = join(CONFIG.screenshotDir, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: false });
    captureLog("harness", "INFO", `Screenshot: ${filename}`);
  } catch (err) {
    captureLog("harness", "WARN", `Screenshot failed: ${err.message}`);
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  captureLog("harness", "FATAL", `Unhandled rejection: ${msg}`);
});

async function main() {
  console.log("Launching Chrome via launchPersistentContext...");

  try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
  await new Promise((r) => setTimeout(r, 1000));

  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    executablePath: CONFIG.chromePath,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  let page = context.pages()[0] || await context.newPage();
  let pageAlive = true;

  // Block EdPuzzle's auto turn-in API call
  await context.route('**/turn_in**', (route) => {
    captureLog("harness", "WARN", "BLOCKED auto turn-in request — user must turn in manually");
    route.abort();
  });

  await context.addInitScript({ content: injectorCode });
  captureLog("harness", "INFO", "Registered injector3.js via addInitScript");

  const listenedPages = new WeakSet();
  function attachPageListeners(p) {
    if (listenedPages.has(p)) return;
    listenedPages.add(p);
    p.on("console", (msg) => captureLog("page", msg.type().toUpperCase(), msg.text()));
    p.on("pageerror", (err) => captureLog("page", "ERROR", err.message));
    p.on("response", (resp) => {
      const url = resp.url();
      if (url.includes("/api/v") || url.includes("/graphql")) {
        captureLog("network", "RES", `${resp.status()} ${url}`);
      }
    });
    p.on("close", () => {
      captureLog("harness", "WARN", "Page closed!");
      if (p === page) pageAlive = false;
    });
  }

  attachPageListeners(page);
  context.on("page", (newPage) => {
    captureLog("harness", "INFO", "New page opened — attaching listeners");
    attachPageListeners(newPage);
  });

  // Auth check
  console.log("Checking EdPuzzle login status...");
  const authPromise = page.waitForResponse(
    (r) => r.url().includes("/api/v3/users/me"), { timeout: 15_000 }
  ).then((r) => r.status() === 200).catch(() => false);

  await page.goto("https://edpuzzle.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const loggedIn = await authPromise;

  if (!loggedIn) {
    console.log("\nNOT LOGGED IN — please log in, then press ENTER.");
    await new Promise((resolve) => process.stdin.once("data", resolve));
  } else {
    console.log("Already logged in.\n");
  }

  const allPages = context.pages();
  if (allPages.length > 1) page = allPages[allPages.length - 1];
  attachPageListeners(page);
  pageAlive = true;

  // Brute-force attempt tracker — persists across retries
  const questionAttempts = new Map();

  for (const scenario of CONFIG.scenarios) {
    let retryCount = 0;
    const MAX_RETRIES = 10;

    retryLoop:
    while (retryCount <= MAX_RETRIES) {
      if (retryCount > 0) {
        captureLog("harness", "INFO", `=== RETRY #${retryCount} — attempting to improve score ===`);
      }

      console.log("=".repeat(60));
      console.log(`SCENARIO: ${scenario.name}${retryCount > 0 ? ` (retry #${retryCount})` : ""}`);
      console.log("=".repeat(60) + "\n");

      await page.goto(scenario.url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
      // EdPuzzle may redirect/replace page (e.g. URLs without attachmentId)
      await new Promise(r => setTimeout(r, 3000));
      if (!pageAlive) {
        const pages = context.pages();
        if (pages.length > 0) {
          page = pages[pages.length - 1];
          attachPageListeners(page);
          pageAlive = true;
          captureLog("harness", "INFO", `Page replaced after redirect — switched to new page`);
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        } else {
          page = await context.newPage();
          attachPageListeners(page);
          pageAlive = true;
          await page.goto(scenario.url, { waitUntil: "networkidle", timeout: 30_000 });
        }
      }
      await screenshot(page, scenario, retryCount === 0 ? "01-loaded" : `retry${retryCount}-loaded`);
      await page.waitForTimeout(CONFIG.pageLoadWait);
      try { await page.addStyleTag({ content: stylesCode }); } catch {}

      // Click Play
      captureLog("harness", "INFO", "Clicking Play to start video...");
      try {
        await page.locator('button[aria-label="Play"]').click({ timeout: 5000 });
      } catch {
        captureLog("harness", "WARN", "Play button not found, trying center click");
        await page.mouse.click(400, 400);
      }
      await page.waitForTimeout(2000);
      await screenshot(page, scenario, retryCount === 0 ? "02-after-play" : `retry${retryCount}-play`);

      // Main answer loop
      captureLog("harness", "INFO", "Starting answer loop...");
      let questionsAnswered = 0;
      let notesDismissed = 0;
      let stuckCount = 0;
      const loopStart = Date.now();

      while (Date.now() - loopStart < 1_800_000 && stuckCount < 30) {
        // Page recovery
        if (!pageAlive) {
          const pages = context.pages();
          if (pages.length === 0) {
            captureLog("harness", "WARN", "No pages — creating new page");
            try {
              page = await context.newPage();
              attachPageListeners(page);
              pageAlive = true;
              await page.goto(scenario.url, { waitUntil: "networkidle", timeout: 30_000 });
              await page.waitForTimeout(3000);
              try { await page.locator('button[aria-label="Play"]').click({ timeout: 5000 }); } catch { await page.mouse.click(400, 400); }
              await page.waitForTimeout(2000);
            } catch (e) {
              captureLog("harness", "FATAL", `Recovery failed: ${e.message.substring(0, 80)}`);
              break;
            }
          } else {
            page = pages[pages.length - 1];
            attachPageListeners(page);
            pageAlive = true;
            captureLog("harness", "INFO", `Recovered page (${pages.length} open)`);
          }
        }

        try { await page.waitForTimeout(1500); } catch { continue; }

        try {
          const choiceLocator = page.locator('[data-test-id*="choice"]');
          const choiceCount = await choiceLocator.count();

          const continueBtn = page.locator('button').filter({ hasText: /^(Continue|Next question|Next)$/i }).first();
          const hasContinue = await continueBtn.isVisible().catch(() => false);

          const submitBtn = page.locator('button').filter({ hasText: /^(Submit|Check)$/i }).first();
          const submitVisible = await submitBtn.isVisible().catch(() => false);
          const submitEnabled = submitVisible && await submitBtn.evaluate(
            el => !el.disabled && el.getAttribute("aria-disabled") !== "true"
          ).catch(() => false);

          // Check for text inputs (fill-in-the-blank)
          const textInput = page.locator('input[type="text"]:visible, textarea:visible, [contenteditable="true"]:visible').first();
          const hasTextInput = await textInput.isVisible().catch(() => false);

          // Count checked choices and detect checkbox presence
          let checkedCount = 0;
          let hasCheckboxes = false;
          if (choiceCount > 0) {
            for (let c = 0; c < choiceCount; c++) {
              const inp = choiceLocator.nth(c).locator('input[type="checkbox"], input[type="radio"]');
              const inpCount = await inp.count().catch(() => 0);
              if (inpCount > 0) {
                hasCheckboxes = true;
                const isChk = await inp.first().evaluate(el => el.checked).catch(() => false);
                if (isChk) checkedCount++;
              }
            }
          }

          // Build question fingerprint from choice texts
          let fingerprint = "";
          if (choiceCount > 0 && hasCheckboxes && checkedCount === 0) {
            const parts = [];
            for (let i = 0; i < Math.min(choiceCount, 4); i++) {
              const txt = await choiceLocator.nth(i).innerText().catch(() => "");
              parts.push(txt.trim().substring(0, 30));
            }
            fingerprint = parts.join("|");
          }

          // P1: Note/info screen
          if (hasContinue && choiceCount === 0 && !hasTextInput) {
            notesDismissed++;
            captureLog("harness", "INFO", `Clicking Continue (note #${notesDismissed})`);
            await continueBtn.click().catch(() => {});
            stuckCount = 0;
            continue;
          }

          // P2: Review mode — already answered
          if (hasContinue && (checkedCount > 0 || (choiceCount === 0 && hasTextInput) || (choiceCount > 0 && !hasCheckboxes))) {
            questionsAnswered++;
            captureLog("harness", "INFO", `Clicking Next (Q#${questionsAnswered} — review, chk:${checkedCount}/${choiceCount})`);
            await continueBtn.click().catch(() => {});
            stuckCount = 0;
            continue;
          }

          // P3: Open-ended / fill-in-the-blank — PAUSE and let user answer manually
          if (hasTextInput && !hasContinue) {
            await screenshot(page, scenario, `open-ended-PAUSED-${questionsAnswered}`);
            captureLog("harness", "WARN", "═══════════════════════════════════════════════════════");
            captureLog("harness", "WARN", "⚠  OPEN-ENDED QUESTION DETECTED — automation paused.");
            captureLog("harness", "WARN", "   Answer this question manually in the browser window.");
            captureLog("harness", "WARN", "   Then re-run: node run.js   (bot will skip past it)");
            captureLog("harness", "WARN", "═══════════════════════════════════════════════════════");
            // Leave browser open so user can answer, then exit cleanly
            break retryLoop;
          }

          // P4: Unanswered MC — brute-force with attempt tracking
          if (choiceCount > 0 && hasCheckboxes && checkedCount === 0) {
            const attempts = questionAttempts.get(fingerprint) || 0;
            const choiceIndex = attempts % choiceCount;
            questionAttempts.set(fingerprint, attempts + 1);

            const choice = choiceLocator.nth(choiceIndex);
            const text = await choice.innerText().catch(() => "?");
            captureLog("harness", "INFO", `Q: "${fingerprint.substring(0, 40)}..." attempt #${attempts + 1} → choice ${choiceIndex}: "${text.substring(0, 50).trim()}"`);

            const input = choice.locator('input[type="checkbox"], input[type="radio"]').first();
            let checked = false;

            // S1: Click choice container
            await choice.click();
            await page.waitForTimeout(500);
            checked = await input.evaluate(el => el.checked).catch(() => false);

            // S2: Click input directly
            if (!checked) {
              try {
                await input.click({ force: true });
                await page.waitForTimeout(500);
                checked = await input.evaluate(el => el.checked).catch(() => false);
              } catch {}
            }

            // S3: Playwright .check()
            if (!checked) {
              try {
                await input.check({ timeout: 3000 });
                checked = true;
              } catch {}
            }

            // S4: Focus + Space
            if (!checked) {
              try {
                await input.focus();
                await page.keyboard.press('Space');
                await page.waitForTimeout(500);
                checked = await input.evaluate(el => el.checked).catch(() => false);
              } catch {}
            }

            // S5: Call React fiber onToggle handler (EdPuzzle's actual toggle mechanism)
            if (!checked) {
              try {
                const toggled = await page.evaluate((ci) => {
                  const choices = document.querySelectorAll('[data-test-id*="choice"]:not([data-test-id="choice-content"])');
                  const ch = choices[ci];
                  if (!ch) return false;
                  const fk = Object.keys(ch).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                  if (!fk) return false;
                  let f = ch[fk], d = 0;
                  while (f && d < 35) {
                    const p = f.memoizedProps || f.pendingProps || {};
                    if (typeof p.onToggle === 'function') {
                      p.onToggle();
                      return true;
                    }
                    f = f.return;
                    d++;
                  }
                  return false;
                }, choiceIndex);
                if (toggled) {
                  await page.waitForTimeout(500);
                  checked = await input.evaluate(el => el.checked).catch(() => false);
                  captureLog("harness", "DEBUG", `S5 onToggle: toggled=${toggled} checked=${checked}`);
                }
              } catch {}
            }

            // S6: Walk fiber from inner elements (input, label) for onChange/onToggle
            if (!checked) {
              try {
                const result = await page.evaluate((ci) => {
                  const choices = document.querySelectorAll('[data-test-id*="choice"]:not([data-test-id="choice-content"])');
                  const ch = choices[ci];
                  if (!ch) return false;
                  const targets = [ch.querySelector('input'), ch.querySelector('label'), ch.querySelector('[data-test-id="choice-content"]'), ch].filter(Boolean);
                  for (const el of targets) {
                    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                    if (!fk) continue;
                    let f = el[fk], d = 0;
                    while (f && d < 35) {
                      const p = f.memoizedProps || f.pendingProps || {};
                      for (const h of ['onToggle', 'onClick', 'onChange']) {
                        if (typeof p[h] === 'function') {
                          if (h === 'onChange') {
                            const inp = ch.querySelector('input');
                            if (inp) {
                              const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
                              ns.call(inp, true);
                            }
                            p[h]({ type: 'change', target: inp || el, currentTarget: inp || el, bubbles: true, preventDefault(){}, stopPropagation(){}, persist(){}, nativeEvent: new Event('change') });
                          } else {
                            p[h]();
                          }
                          return h + '@d' + d;
                        }
                      }
                      f = f.return;
                      d++;
                    }
                  }
                  return false;
                }, choiceIndex);
                if (result) {
                  await page.waitForTimeout(500);
                  checked = await input.evaluate(el => el.checked).catch(() => false);
                  captureLog("harness", "DEBUG", `S6 fiber walk: handler=${result} checked=${checked}`);
                }
              } catch (e) {
                captureLog("harness", "DEBUG", `S6 error: ${e.message.substring(0,60)}`);
              }
            }

            captureLog("harness", "INFO", `Choice ${choiceIndex} checked=${checked}`);
            stuckCount = checked ? 0 : stuckCount + 1;

            if (!checked) continue;

            await page.waitForTimeout(500);

            // Wait for Submit
            try {
              await page.waitForFunction(() => {
                const btns = [...document.querySelectorAll("button")];
                return btns.some(b => /^(submit|check)$/i.test(b.textContent.trim()) && !b.disabled && b.getAttribute("aria-disabled") !== "true");
              }, { timeout: 4000 });
              const sub = page.locator('button').filter({ hasText: /^(Submit|Check)$/i }).first();
              captureLog("harness", "INFO", "Submit enabled — clicking");
              await sub.click();
              await page.waitForTimeout(1500);

              // Check if correct (Continue/Next appears) or wrong (video replays)
              const next = page.locator('button').filter({ hasText: /^(Continue|Next question|Next)$/i }).first();
              try {
                await next.waitFor({ state: "visible", timeout: 4000 });
                questionsAnswered++;
                captureLog("harness", "INFO", `Clicking Continue/Next (Q#${questionsAnswered}) — answer accepted`);
                await next.click();
                await page.waitForTimeout(1000);
              } catch {
                captureLog("harness", "INFO", "No Continue — wrong answer, video will replay. Will try next choice.");
              }
            } catch {
              captureLog("harness", "WARN", "Submit not enabled after choice click");
            }
            continue;
          }

          // P5: Non-MC choices with Continue
          if (choiceCount > 0 && !hasCheckboxes && hasContinue) {
            questionsAnswered++;
            captureLog("harness", "INFO", `Clicking Continue (non-MC Q#${questionsAnswered})`);
            await continueBtn.click().catch(() => {});
            stuckCount = 0;
            continue;
          }

          // P6: Submit with no choices
          if (submitEnabled) {
            await submitBtn.click().catch(() => {});
            stuckCount = 0;
            continue;
          }

          // P7: Continue fallback
          if (hasContinue) {
            captureLog("harness", "INFO", "Clicking Continue (fallback)");
            await continueBtn.click().catch(() => {});
            stuckCount = 0;
            continue;
          }

          // Nothing interactive — video playing
          stuckCount++;
          const elapsed = Math.round((Date.now() - loopStart) / 1000);
          if (stuckCount % 5 === 0) {
            captureLog("harness", "INFO", `Waiting... ${elapsed}s (Q:${questionsAnswered} N:${notesDismissed} stuck:${stuckCount}/30)`);
            await screenshot(page, scenario, `wait-${elapsed}s`);
          }
        } catch (err) {
          const msg = err.message || String(err);
          captureLog("harness", "ERROR", `Loop error: ${msg.substring(0, 120)}`);
          if (msg.includes("Target page") || msg.includes("has been closed") || msg.includes("Target closed")) {
            pageAlive = false;
          } else {
            stuckCount++;
          }
        }
      }

      captureLog("harness", "INFO", `Loop done: ${questionsAnswered} answered, ${notesDismissed} notes, ${Math.round((Date.now() - loopStart) / 1000)}s`);
      await screenshot(page, scenario, `pass${retryCount}-final`);

      // === SCORE CHECK — do NOT turn in unless 100% ===
      captureLog("harness", "INFO", "Checking score before turn-in...");
      await page.waitForTimeout(2000);

      const score = await page.evaluate(() => {
        // Look for score text like "15/42" or "100%" anywhere on page
        const all = document.body.innerText;
        // Match patterns like "Score: 15/42" or "42/42" or "100%"
        const scoreMatch = all.match(/(\d+)\s*\/\s*(\d+)/);
        if (scoreMatch) return { got: parseInt(scoreMatch[1]), total: parseInt(scoreMatch[2]) };
        const pctMatch = all.match(/(\d+)%/);
        if (pctMatch) return { pct: parseInt(pctMatch[1]) };
        return null;
      }).catch(() => null);

      if (score) {
        captureLog("harness", "INFO", `Score detected: ${JSON.stringify(score)}`);
      } else {
        captureLog("harness", "WARN", "Could not detect score from page text");
      }

      const isPerfect = score && ((score.got !== undefined && score.got === score.total) || (score.pct !== undefined && score.pct === 100));

      if (isPerfect) {
        captureLog("harness", "INFO", "PERFECT SCORE! NOT turning in — user must turn in manually.");
        await screenshot(page, scenario, "perfect-score");
        break retryLoop;
      }

      // Not perfect — try to retry
      captureLog("harness", "INFO", `Score not 100% — looking for Retry button (retry #${retryCount + 1})...`);
      await screenshot(page, scenario, `score-check-retry${retryCount}`);

      const retryBtn = page.locator('button, a').filter({ hasText: /retry|try again|retake|redo/i }).first();
      const hasRetry = await retryBtn.isVisible().catch(() => false);

      if (hasRetry) {
        captureLog("harness", "INFO", "Clicking Retry to improve score");
        await retryBtn.click();
        await page.waitForTimeout(3000);
        retryCount++;
        continue retryLoop;
      }

      // No retry button — maybe need to navigate back
      captureLog("harness", "WARN", "No Retry button found. Navigating back to assignment...");
      retryCount++;
      continue retryLoop;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("RUN COMPLETE");
  console.log(`Total logs: ${allLogs.length}`);
  console.log(`Questions tracked: ${questionAttempts.size}`);
  console.log(`Screenshots: ${CONFIG.screenshotDir}`);
  console.log("=".repeat(60));

  logStream.end();
  await context.close();
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  logStream.end();
  try { execSync("taskkill /F /IM chrome.exe", { stdio: "ignore" }); } catch {}
  process.exit(1);
});
