import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:5180";

export default defineConfig({
  testDir: "./tests",
  reporter: [
    ["list"],
    [
      "@camerihq/playwright-reporter",
      { serverUrl: process.env.CAMERI_SERVER_URL ?? "http://localhost:3000" },
    ],
  ],
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @camerihq/demo dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
