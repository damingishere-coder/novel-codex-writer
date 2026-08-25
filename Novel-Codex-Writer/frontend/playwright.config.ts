import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const frontendRoot = dirname(fileURLToPath(import.meta.url));
const libraryRoot = resolve(frontendRoot, ".e2e-library");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4178",
    channel: process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "true" ? "chrome" : undefined,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "npm run e2e:serve",
    url: "http://127.0.0.1:4178/api/projects",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      AI_MOCK_MODE: "true",
      NOVEL_LIBRARY_ROOT: libraryRoot
    }
  }
});
