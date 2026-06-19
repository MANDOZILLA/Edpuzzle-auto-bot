import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",

  // Persistent profile — log in once, reuse forever
  userDataDir: "C:\\Users\\whyhe\\AppData\\Local\\EdPuzzleTestProfile",

  // Extension root (one dir up from test/)
  extensionPath: resolve(__dirname, ".."),

  scenarios: [
    {
      name: "assignment-6a0b1574",
      url: "https://edpuzzle.com/assignments/6a0b15743270b21e0c232bd3/watch?authuser=0",
      observeDuration: 60_000,
      screenshotInterval: 15_000,
    },
  ],

  pageLoadWait: 8_000,
  screenshotDir: resolve(__dirname, "screenshots"),
  logDir: resolve(__dirname, "logs"),
};
