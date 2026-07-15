import { describe, expect, it } from "vitest";

import { assertSafeComposition, bootstrapComposition, buildCompositionManifest, loadRuntimeConfig } from "../src/composition";

function environment(overrides: Readonly<Record<string, string | undefined>> = {}): Readonly<Record<string, string | undefined>> {
  return {
    APP_ENVIRONMENT: "development",
    APP_PUBLIC_ORIGIN: "http://localhost:3000",
    PROVIDER_BILLING_MODE: "free_only",
    LOCAL_PROVIDER_CREDENTIAL_MODE: "contract_only",
    CREDENTIAL_VAULT_PROVIDER: "disabled",
    ...overrides,
  };
}

describe("runtime policy", () => {
  it("builds a secret-free default composition with no paid or Live Trading registrations", () => {
    const config = loadRuntimeConfig(environment());
    const manifest = buildCompositionManifest(config);
    assertSafeComposition(config, manifest);
    expect(manifest).toEqual({
      paidAdapters: [], paidRoutes: [], paidSchedules: [], liveSubmitCapabilities: [], liveSubmitRoutes: [], syntheticProviders: [],
      identityProviders: [], emailDeliveryProviders: [],
    });
  });

  it("rejects forbidden registrations even if a registry is assembled incorrectly", () => {
    const config = loadRuntimeConfig(environment());
    expect(() => assertSafeComposition(config, { ...buildCompositionManifest(config), paidRoutes: ["premium"] })).toThrow("unsafe paid");
  });

  it.each([
    ["missing environment", { APP_ENVIRONMENT: undefined }],
    ["non-canonical origin", { APP_PUBLIC_ORIGIN: "http://localhost:3000/path" }],
    ["paid adapter", { ENABLED_PAID_ADAPTERS: "premium-feed" }],
    ["paid route", { ENABLED_PAID_ROUTES: "premium-quote" }],
    ["paid schedule", { ENABLED_PAID_SCHEDULES: "premium-refresh" }],
    ["live submit", { ENABLE_LIVE_TRADING: "true" }],
    ["partial Alpaca credential", { ALPACA_API_KEY_ID: "sentinel" }],
    ["unbound global credential", { ALPACA_API_KEY_ID: "sentinel", ALPACA_API_SECRET_KEY: "sentinel" }],
  ])("rejects %s before composition", (_label, override) => {
    expect(() => loadRuntimeConfig(environment(override))).toThrow();
  });

  it("allows complete process-global credentials only for an explicit contract job", () => {
    expect(() => loadRuntimeConfig(environment({
      ALPACA_API_KEY_ID: "sentinel",
      ALPACA_API_SECRET_KEY: "sentinel",
      RUN_ALPACA_BASIC_DATA_CONTRACT: "true",
    }))).not.toThrow();
  });

  it("does not let one provider contract flag authorize another provider credential", () => {
    expect(() => loadRuntimeConfig(environment({
      KIS_APP_KEY: "sentinel",
      KIS_APP_SECRET: "sentinel",
      RUN_ALPACA_BASIC_DATA_CONTRACT: "true",
    }))).toThrow("KIS process-global credentials require a KIS contract opt-in");
  });

  it("requires single_owner to be immutable development scope", () => {
    expect(() => loadRuntimeConfig(environment({ LOCAL_PROVIDER_CREDENTIAL_MODE: "single_owner" }))).toThrow();
    expect(() => loadRuntimeConfig(environment({
      LOCAL_PROVIDER_CREDENTIAL_MODE: "single_owner",
      LOCAL_PROVIDER_OWNER_WORKSPACE_ID: "workspace-1",
    }))).not.toThrow();
    expect(() => loadRuntimeConfig(environment({
      APP_ENVIRONMENT: "staging",
      APP_PUBLIC_ORIGIN: "https://staging.example.com",
      LOCAL_PROVIDER_CREDENTIAL_MODE: "single_owner",
      LOCAL_PROVIDER_OWNER_WORKSPACE_ID: "workspace-1",
    }))).toThrow();
  });

  it.each(["staging", "production"])("rejects local vault in %s", (appEnvironment) => {
    expect(() => loadRuntimeConfig(environment({
      APP_ENVIRONMENT: appEnvironment,
      APP_PUBLIC_ORIGIN: "https://terminal.example.com",
      CREDENTIAL_VAULT_PROVIDER: "local",
    }))).toThrow();
  });

  it("rejects synthetic production composition and insecure production origin", () => {
    expect(() => loadRuntimeConfig(environment({ APP_ENVIRONMENT: "production", ENABLE_SYNTHETIC_PROVIDER: "true", APP_PUBLIC_ORIGIN: "https://terminal.example.com" }))).toThrow();
    expect(() => loadRuntimeConfig(environment({ APP_ENVIRONMENT: "production", APP_PUBLIC_ORIGIN: "http://terminal.example.com" }))).toThrow();
    const config = loadRuntimeConfig(environment({ APP_ENVIRONMENT: "production", APP_PUBLIC_ORIGIN: "https://terminal.example.com" }));
    expect(buildCompositionManifest(config).syntheticProviders).toHaveLength(0);
  });

  it("fails closed on disabled, partial, or redirected federated identity configuration", () => {
    expect(() => loadRuntimeConfig(environment({ GOOGLE_IDENTITY_CLIENT_ID: "client" }))).toThrow("Google identity configuration");
    expect(() => loadRuntimeConfig(environment({ GOOGLE_IDENTITY_ENABLED: "true", GOOGLE_IDENTITY_CLIENT_ID: "client" }))).toThrow("Google identity configuration");
    expect(() => loadRuntimeConfig(environment({
      GOOGLE_IDENTITY_ENABLED: "true",
      GOOGLE_IDENTITY_CLIENT_ID: "client",
      GOOGLE_IDENTITY_CLIENT_SECRET: "sentinel",
      GOOGLE_IDENTITY_CALLBACK_PATH: "/attacker/callback",
    }))).toThrow("Google identity configuration");
    const config = loadRuntimeConfig(environment({
      GOOGLE_IDENTITY_ENABLED: "true",
      GOOGLE_IDENTITY_CLIENT_ID: "client",
      GOOGLE_IDENTITY_CLIENT_SECRET: "sentinel",
      GOOGLE_IDENTITY_CALLBACK_PATH: "/auth/callback/google",
    }));
    expect(config.identityProviders).toEqual(["google"]);
  });

  it("fails closed on partial or environment-incompatible delivery configuration", () => {
    expect(() => loadRuntimeConfig(environment({ EMAIL_FROM_ADDRESS: "sender@example.com" }))).toThrow("partial sender");
    expect(() => loadRuntimeConfig(environment({ EMAIL_DELIVERY_PROVIDER: "mailpit" }))).toThrow("enabled delivery keyring");
    expect(() => loadRuntimeConfig(environment({
      DELIVERY_KEYRING_PROVIDER: "local",
      EMAIL_DELIVERY_PROVIDER: "mailpit",
      MAILPIT_SMTP_HOST: "mailpit",
      MAILPIT_SMTP_PORT: "1025",
    }))).not.toThrow();
    expect(() => loadRuntimeConfig(environment({
      APP_ENVIRONMENT: "production",
      APP_PUBLIC_ORIGIN: "https://terminal.example.com",
      DELIVERY_KEYRING_PROVIDER: "local",
      EMAIL_DELIVERY_PROVIDER: "mailpit",
      MAILPIT_SMTP_HOST: "mailpit",
      MAILPIT_SMTP_PORT: "1025",
    }))).toThrow();
    expect(() => loadRuntimeConfig(environment({
      DELIVERY_KEYRING_PROVIDER: "local",
      EMAIL_DELIVERY_PROVIDER: "resend",
      EMAIL_FROM_ADDRESS: "not-an-email",
      EMAIL_FROM_NAME: "Terminal",
    }))).toThrow("Resend requires");
  });

  it("does not register Resend when its local delivery keyring is unavailable", () => {
    expect(() => bootstrapComposition(environment({
      DELIVERY_KEYRING_PROVIDER: "local",
      DELIVERY_LOCAL_KEYRING_FILE: ".secrets/missing-delivery-keyring.json",
      EMAIL_DELIVERY_PROVIDER: "resend",
      EMAIL_FROM_ADDRESS: "sender@example.com",
      EMAIL_FROM_NAME: "Terminal",
    }))).toThrow();
  });

  it("does not read a local delivery keyring when external email is disabled", () => {
    expect(() => bootstrapComposition(environment({
      DELIVERY_KEYRING_PROVIDER: "local",
      DELIVERY_LOCAL_KEYRING_FILE: ".secrets/missing-delivery-keyring.json",
      EMAIL_DELIVERY_PROVIDER: "disabled",
    }))).not.toThrow();
  });

  it("requires managed vault references to match their provider", () => {
    expect(() => loadRuntimeConfig(environment({ CREDENTIAL_VAULT_PROVIDER: "kms" }))).toThrow("key reference");
    expect(() => loadRuntimeConfig(environment({ CREDENTIAL_VAULT_KMS_KEY_REF: "kms-key" }))).toThrow("key reference");
    expect(() => loadRuntimeConfig(environment({ CREDENTIAL_VAULT_PROVIDER: "kms", CREDENTIAL_VAULT_KMS_KEY_REF: "kms-key" }))).not.toThrow();
  });
});
