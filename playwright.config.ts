import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1366",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "mobile-360",
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      APP_ENVIRONMENT: "development",
      APP_PUBLIC_ORIGIN: baseURL,
      PROVIDER_BILLING_MODE: "free_only",
      LOCAL_PROVIDER_CREDENTIAL_MODE: "contract_only",
      CREDENTIAL_VAULT_PROVIDER: "disabled",
      ENABLE_SYNTHETIC_PROVIDER: "false",
      ENABLE_LIVE_TRADING: "false",
      ENABLED_PAID_ADAPTERS: "",
      ENABLED_PAID_ROUTES: "",
      ENABLED_PAID_SCHEDULES: "",
      F1_SCRIPTED_PROVIDER_DELAY_MS: "20",
      RUN_ALPACA_BASIC_DATA_CONTRACT: "false",
      RUN_KIS_PERSONAL_DATA_CONTRACT: "false",
      RUN_ALPACA_PAPER_READ_CONTRACT: "false",
      RUN_KIS_PAPER_READ_CONTRACT: "false",
      RUN_ALPACA_PAPER_ORDER_CONTRACT: "false",
      RUN_KIS_PAPER_ORDER_CONTRACT: "false",
      ALPACA_API_KEY_ID: "",
      ALPACA_API_SECRET_KEY: "",
      KIS_APP_KEY: "",
      KIS_APP_SECRET: "",
      GOOGLE_IDENTITY_ENABLED: "false",
      GOOGLE_IDENTITY_CLIENT_ID: "",
      GOOGLE_IDENTITY_CLIENT_SECRET: "",
      GITHUB_IDENTITY_ENABLED: "false",
      GITHUB_IDENTITY_CLIENT_ID: "",
      GITHUB_IDENTITY_CLIENT_SECRET: "",
      DELIVERY_KEYRING_PROVIDER: "disabled",
      EMAIL_DELIVERY_PROVIDER: "disabled",
    },
  },
});
