import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:32287",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx tsx tests/ui-host.ts",
    url: "http://127.0.0.1:32287/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
  timeout: 30000,
});
