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
      // 개발자 .env.local이 single_owner + owner workspace로 떠 있어도 이 레인은 자기 조합을 끝까지
      // 고정한다 — 짝이 되는 값을 비우지 않으면 부팅이 "owner workspace is valid only for
      // single_owner"로 거절된다(2026-07-21 실제 발생). 결정론 레인에 개인 키 흔적을 남기지 않는다.
      LOCAL_PROVIDER_OWNER_WORKSPACE_ID: "",
      IDENTITY_PERSISTENCE: "memory",
      PUBLIC_MARKET_ENABLED: "false",
      F1_GUEST_MODE: "",
      CREDENTIAL_VAULT_PROVIDER: "disabled",
      ENABLE_SYNTHETIC_PROVIDER: "false",
      ENABLE_LIVE_TRADING: "false",
      ENABLED_PAID_ADAPTERS: "",
      ENABLED_PAID_ROUTES: "",
      ENABLED_PAID_SCHEDULES: "",
      F1_SCRIPTED_PROVIDER_DELAY_MS: "20",
      RUN_KIS_PERSONAL_DATA_CONTRACT: "false",
      RUN_KIS_PAPER_READ_CONTRACT: "false",
      RUN_KIS_PAPER_ORDER_CONTRACT: "false",
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
