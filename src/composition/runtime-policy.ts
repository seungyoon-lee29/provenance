import { z } from "zod";

const environmentSchema = z.enum(["development", "test", "staging", "production"]);
const booleanFlagSchema = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const baseRuntimeSchema = z.object({
  APP_ENVIRONMENT: environmentSchema,
  APP_PUBLIC_ORIGIN: z.string().url(),
  PROVIDER_BILLING_MODE: z.literal("free_only"),
  LOCAL_PROVIDER_CREDENTIAL_MODE: z.enum(["contract_only", "single_owner"]),
  LOCAL_PROVIDER_OWNER_WORKSPACE_ID: z.string().optional(),
  IDENTITY_PERSISTENCE: z.enum(["memory", "postgres"]).default("memory"),
  CREDENTIAL_VAULT_PROVIDER: z.enum(["disabled", "local", "kms", "secret_manager"]),
  CREDENTIAL_LOCAL_KEYRING_FILE: z.string().default(".secrets/credential-keyring.json"),
  CREDENTIAL_VAULT_KMS_KEY_REF: z.string().optional(),
  ENABLE_SYNTHETIC_PROVIDER: booleanFlagSchema,
  PUBLIC_MARKET_ENABLED: booleanFlagSchema,
  // ticket 28's treasury-named flag, retired in 32: the public track now covers more providers
  // (ECB, DART), so the old opt-in must NOT silently widen — setting it is a startup error.
  PUBLIC_MARKET_TREASURY_ENABLED: z.string().optional(),
  ENABLE_LIVE_TRADING: booleanFlagSchema,
  ENABLED_PAID_ADAPTERS: z.string().default(""),
  ENABLED_PAID_ROUTES: z.string().default(""),
  ENABLED_PAID_SCHEDULES: z.string().default(""),
  RUN_KIS_PERSONAL_DATA_CONTRACT: booleanFlagSchema,
  RUN_KIS_PAPER_READ_CONTRACT: booleanFlagSchema,
  RUN_KIS_PAPER_ORDER_CONTRACT: booleanFlagSchema,
  KIS_APP_KEY: z.string().optional(),
  KIS_APP_SECRET: z.string().optional(),
  KIS_REST_BASE: z.string().optional(),
  // 실전(live) 키는 시세 조회 전용 — 모의 도메인에 없는 데이터(과거 분봉·지수 현재가·ETF)용.
  // 주문 경로에는 배선하지 않는다. 배선 지점은 다음 티켓에서 결정한다.
  KIS_LIVE_APP_KEY: z.string().optional(),
  KIS_LIVE_APP_SECRET: z.string().optional(),
  GOOGLE_IDENTITY_ENABLED: booleanFlagSchema,
  GOOGLE_IDENTITY_CLIENT_ID: z.string().optional(),
  GOOGLE_IDENTITY_CLIENT_SECRET: z.string().optional(),
  GOOGLE_IDENTITY_CALLBACK_PATH: z.string().default("/auth/callback/google"),
  GITHUB_IDENTITY_ENABLED: booleanFlagSchema,
  GITHUB_IDENTITY_CLIENT_ID: z.string().optional(),
  GITHUB_IDENTITY_CLIENT_SECRET: z.string().optional(),
  GITHUB_IDENTITY_CALLBACK_PATH: z.string().default("/auth/callback/github"),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export type RuntimeConfig = Readonly<{
  environment: AppEnvironment;
  publicOrigin: string;
  providerBillingMode: "free_only";
  localProviderCredentialMode: "contract_only" | "single_owner";
  localProviderOwnerWorkspaceId?: string;
  /** true only when the KIS personal market provider can be wired: single_owner + owner workspace + KIS creds + paper-read contract. */
  kisMarketEnabled: boolean;
  /** The credential destination — pinned to an official KIS REST origin, never an arbitrary host. */
  kisMarketBase: string;
  /** Opt-in for the keyless public guest-track feeds (rights.md); off = zero external egress. */
  publicMarketEnabled: boolean;
  identityPersistence: "memory" | "postgres";
  credentialVaultProvider: "disabled" | "local" | "kms" | "secret_manager";
  credentialLocalKeyringFile: string;
  syntheticProviderEnabled: boolean;
  identityProviders: readonly ("google" | "github")[];
}>;

// 타입 술어인 이유: 호출부가 `...(isConfigured(x) ? { k: x } : {})` 형태로 선택 속성을
// 채운다. boolean 을 돌려주면 참 가지에서도 x 가 `string | undefined` 라서
// exactOptionalPropertyTypes 아래에서 "없는 키"와 "undefined 를 든 키"가 섞인다.
function isConfigured(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

// The only hosts the KIS credentials may ever be sent to (token POST carries appkey/appsecret). An
// arbitrary KIS_REST_BASE would exfiltrate them, so the destination is pinned, not merely defaulted.
const ALLOWED_KIS_BASES = ["https://openapivts.koreainvestment.com:29443", "https://openapi.koreainvestment.com:9443"] as const;
const DEFAULT_KIS_BASE = ALLOWED_KIS_BASES[0]; // 모의(paper) — the paper-read contract's server

function assertKisBase(parsed: z.infer<typeof baseRuntimeSchema>): void {
  if (isConfigured(parsed.KIS_REST_BASE) && !ALLOWED_KIS_BASES.includes(parsed.KIS_REST_BASE!.trim() as (typeof ALLOWED_KIS_BASES)[number])) {
    throw new Error("KIS_REST_BASE must be an official KIS REST origin");
  }
}

function assertCanonicalOrigin(value: string, environment: AppEnvironment): void {
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("APP_PUBLIC_ORIGIN must be an exact canonical origin without path, query, fragment, or credentials");
  }
  if (environment === "production" && origin.protocol !== "https:") {
    throw new Error("production APP_PUBLIC_ORIGIN must use HTTPS");
  }
}

function assertNoPaidComposition(parsed: z.infer<typeof baseRuntimeSchema>): void {
  if ([parsed.ENABLED_PAID_ADAPTERS, parsed.ENABLED_PAID_ROUTES, parsed.ENABLED_PAID_SCHEDULES].some((value) => value.trim().length > 0)) {
    throw new Error("free_only runtime cannot register paid adapters, routes, or schedules");
  }
  if (parsed.ENABLE_LIVE_TRADING) {
    throw new Error("Live Trading submission is unavailable in this release");
  }
}

function assertCredentialPolicy(parsed: z.infer<typeof baseRuntimeSchema>): void {
  const kisPair = [parsed.KIS_APP_KEY, parsed.KIS_APP_SECRET].map(isConfigured);
  if (kisPair[0] !== kisPair[1]) {
    throw new Error("process-global provider credentials must be configured as a complete pair");
  }

  const hasGlobalCredential = kisPair[0];
  const kisContractOptIn = [
    parsed.RUN_KIS_PERSONAL_DATA_CONTRACT,
    parsed.RUN_KIS_PAPER_READ_CONTRACT,
    parsed.RUN_KIS_PAPER_ORDER_CONTRACT,
  ].some(Boolean);

  if (parsed.LOCAL_PROVIDER_CREDENTIAL_MODE === "single_owner") {
    if (parsed.APP_ENVIRONMENT !== "development" || !isConfigured(parsed.LOCAL_PROVIDER_OWNER_WORKSPACE_ID)) {
      throw new Error("single_owner credentials require an immutable owner workspace in development");
    }
  } else if (isConfigured(parsed.LOCAL_PROVIDER_OWNER_WORKSPACE_ID)) {
    throw new Error("owner workspace is valid only for single_owner credentials");
  }
  if (hasGlobalCredential && parsed.APP_ENVIRONMENT !== "development" && parsed.APP_ENVIRONMENT !== "test") {
    throw new Error("staging and production reject process-global provider credentials");
  }
  if (parsed.LOCAL_PROVIDER_CREDENTIAL_MODE !== "single_owner") {
    if (kisPair[0] && !kisContractOptIn) throw new Error("KIS process-global credentials require a KIS contract opt-in");
  }
}

function assertVaultPolicy(parsed: z.infer<typeof baseRuntimeSchema>): void {
  if ((parsed.APP_ENVIRONMENT === "staging" || parsed.APP_ENVIRONMENT === "production") && parsed.CREDENTIAL_VAULT_PROVIDER === "local") {
    throw new Error("local credential vault is limited to development and test");
  }
  if (parsed.APP_ENVIRONMENT === "production" && !["disabled", "kms", "secret_manager"].includes(parsed.CREDENTIAL_VAULT_PROVIDER)) {
    throw new Error("production credential vault must be disabled, kms, or secret_manager");
  }
  const hasKeyReference = isConfigured(parsed.CREDENTIAL_VAULT_KMS_KEY_REF);
  if (["kms", "secret_manager"].includes(parsed.CREDENTIAL_VAULT_PROVIDER) !== hasKeyReference) {
    throw new Error("managed credential vault and key reference must be configured together");
  }
}

function assertIdentityPolicy(parsed: z.infer<typeof baseRuntimeSchema>): void {
  const providers = [
    {
      name: "Google",
      enabled: parsed.GOOGLE_IDENTITY_ENABLED,
      clientId: parsed.GOOGLE_IDENTITY_CLIENT_ID,
      clientSecret: parsed.GOOGLE_IDENTITY_CLIENT_SECRET,
      callbackPath: parsed.GOOGLE_IDENTITY_CALLBACK_PATH,
      expectedCallbackPath: "/auth/callback/google",
    },
    {
      name: "GitHub",
      enabled: parsed.GITHUB_IDENTITY_ENABLED,
      clientId: parsed.GITHUB_IDENTITY_CLIENT_ID,
      clientSecret: parsed.GITHUB_IDENTITY_CLIENT_SECRET,
      callbackPath: parsed.GITHUB_IDENTITY_CALLBACK_PATH,
      expectedCallbackPath: "/auth/callback/github",
    },
  ];
  for (const provider of providers) {
    const credentialsComplete = isConfigured(provider.clientId) && isConfigured(provider.clientSecret);
    const credentialsAbsent = !isConfigured(provider.clientId) && !isConfigured(provider.clientSecret);
    if (provider.callbackPath !== provider.expectedCallbackPath || (provider.enabled ? !credentialsComplete : !credentialsAbsent)) {
      throw new Error(`${provider.name} identity configuration is incomplete or inconsistent`);
    }
  }
}

export function loadRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  const parsed = baseRuntimeSchema.parse(environment);
  if (isConfigured(parsed.PUBLIC_MARKET_TREASURY_ENABLED)) {
    // Fail closed instead of aliasing: the treasury-only opt-in must not become an ECB+DART grant.
    throw new Error("PUBLIC_MARKET_TREASURY_ENABLED was replaced by PUBLIC_MARKET_ENABLED (now covers all public guest-track feeds) — set the new flag explicitly");
  }
  assertCanonicalOrigin(parsed.APP_PUBLIC_ORIGIN, parsed.APP_ENVIRONMENT);
  assertNoPaidComposition(parsed);
  assertCredentialPolicy(parsed);
  assertKisBase(parsed);
  assertVaultPolicy(parsed);
  assertIdentityPolicy(parsed);
  if (parsed.APP_ENVIRONMENT === "production" && parsed.ENABLE_SYNTHETIC_PROVIDER) {
    throw new Error("production composition rejects synthetic providers");
  }
  return {
    environment: parsed.APP_ENVIRONMENT,
    publicOrigin: parsed.APP_PUBLIC_ORIGIN,
    providerBillingMode: parsed.PROVIDER_BILLING_MODE,
    localProviderCredentialMode: parsed.LOCAL_PROVIDER_CREDENTIAL_MODE,
    ...(isConfigured(parsed.LOCAL_PROVIDER_OWNER_WORKSPACE_ID) ? { localProviderOwnerWorkspaceId: parsed.LOCAL_PROVIDER_OWNER_WORKSPACE_ID } : {}),
    kisMarketEnabled:
      parsed.RUN_KIS_PAPER_READ_CONTRACT &&
      isConfigured(parsed.KIS_APP_KEY) &&
      isConfigured(parsed.KIS_APP_SECRET) &&
      parsed.LOCAL_PROVIDER_CREDENTIAL_MODE === "single_owner" &&
      isConfigured(parsed.LOCAL_PROVIDER_OWNER_WORKSPACE_ID),
    kisMarketBase: isConfigured(parsed.KIS_REST_BASE) ? parsed.KIS_REST_BASE!.trim() : DEFAULT_KIS_BASE,
    publicMarketEnabled: parsed.PUBLIC_MARKET_ENABLED,
    identityPersistence: parsed.IDENTITY_PERSISTENCE,
    credentialVaultProvider: parsed.CREDENTIAL_VAULT_PROVIDER,
    credentialLocalKeyringFile: parsed.CREDENTIAL_LOCAL_KEYRING_FILE,
    syntheticProviderEnabled: parsed.ENABLE_SYNTHETIC_PROVIDER,
    identityProviders: [
      ...(parsed.GOOGLE_IDENTITY_ENABLED ? ["google" as const] : []),
      ...(parsed.GITHUB_IDENTITY_ENABLED ? ["github" as const] : []),
    ],
  };
}
