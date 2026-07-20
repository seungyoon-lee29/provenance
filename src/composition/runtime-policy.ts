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
  ENABLE_LIVE_TRADING: booleanFlagSchema,
  ENABLED_PAID_ADAPTERS: z.string().default(""),
  ENABLED_PAID_ROUTES: z.string().default(""),
  ENABLED_PAID_SCHEDULES: z.string().default(""),
  RUN_ALPACA_BASIC_DATA_CONTRACT: booleanFlagSchema,
  RUN_KIS_PERSONAL_DATA_CONTRACT: booleanFlagSchema,
  RUN_ALPACA_PAPER_READ_CONTRACT: booleanFlagSchema,
  RUN_KIS_PAPER_READ_CONTRACT: booleanFlagSchema,
  RUN_ALPACA_PAPER_ORDER_CONTRACT: booleanFlagSchema,
  RUN_KIS_PAPER_ORDER_CONTRACT: booleanFlagSchema,
  ALPACA_API_KEY_ID: z.string().optional(),
  ALPACA_API_SECRET_KEY: z.string().optional(),
  KIS_APP_KEY: z.string().optional(),
  KIS_APP_SECRET: z.string().optional(),
  KIS_REST_BASE: z.string().optional(),
  GOOGLE_IDENTITY_ENABLED: booleanFlagSchema,
  GOOGLE_IDENTITY_CLIENT_ID: z.string().optional(),
  GOOGLE_IDENTITY_CLIENT_SECRET: z.string().optional(),
  GOOGLE_IDENTITY_CALLBACK_PATH: z.string().default("/auth/callback/google"),
  GITHUB_IDENTITY_ENABLED: booleanFlagSchema,
  GITHUB_IDENTITY_CLIENT_ID: z.string().optional(),
  GITHUB_IDENTITY_CLIENT_SECRET: z.string().optional(),
  GITHUB_IDENTITY_CALLBACK_PATH: z.string().default("/auth/callback/github"),
  DELIVERY_KEYRING_PROVIDER: z.enum(["disabled", "local", "secret_manager"]).default("disabled"),
  DELIVERY_LOCAL_KEYRING_FILE: z.string().default(".secrets/delivery-keyring.json"),
  DELIVERY_KEYRING_REF: z.string().optional(),
  EMAIL_DELIVERY_PROVIDER: z.enum(["disabled", "mailpit", "resend"]).default("disabled"),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  EMAIL_REPLY_TO_ADDRESS: z.string().optional(),
  MAILPIT_SMTP_HOST: z.string().optional(),
  MAILPIT_SMTP_PORT: z.string().optional(),
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
  identityPersistence: "memory" | "postgres";
  credentialVaultProvider: "disabled" | "local" | "kms" | "secret_manager";
  credentialLocalKeyringFile: string;
  syntheticProviderEnabled: boolean;
  identityProviders: readonly ("google" | "github")[];
  deliveryKeyringProvider: "disabled" | "local" | "secret_manager";
  deliveryLocalKeyringFile: string;
  emailDeliveryProvider: "disabled" | "mailpit" | "resend";
}>;

function isConfigured(value: string | undefined): boolean {
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
  const alpacaPair = [parsed.ALPACA_API_KEY_ID, parsed.ALPACA_API_SECRET_KEY].map(isConfigured);
  const kisPair = [parsed.KIS_APP_KEY, parsed.KIS_APP_SECRET].map(isConfigured);
  if (alpacaPair[0] !== alpacaPair[1] || kisPair[0] !== kisPair[1]) {
    throw new Error("process-global provider credentials must be configured as a complete pair");
  }

  const hasGlobalCredential = alpacaPair[0] || kisPair[0];
  const alpacaContractOptIn = [
    parsed.RUN_ALPACA_BASIC_DATA_CONTRACT,
    parsed.RUN_ALPACA_PAPER_READ_CONTRACT,
    parsed.RUN_ALPACA_PAPER_ORDER_CONTRACT,
  ].some(Boolean);
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
    if (alpacaPair[0] && !alpacaContractOptIn) throw new Error("Alpaca process-global credentials require an Alpaca contract opt-in");
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

function assertDeliveryPolicy(parsed: z.infer<typeof baseRuntimeSchema>): void {
  if ((parsed.APP_ENVIRONMENT === "staging" || parsed.APP_ENVIRONMENT === "production") && parsed.DELIVERY_KEYRING_PROVIDER === "local") {
    throw new Error("local delivery keyring is limited to development and test");
  }
  if (parsed.APP_ENVIRONMENT === "production" && !["disabled", "secret_manager"].includes(parsed.DELIVERY_KEYRING_PROVIDER)) {
    throw new Error("production delivery keyring must be disabled or secret_manager");
  }
  const hasDeliveryReference = isConfigured(parsed.DELIVERY_KEYRING_REF);
  if ((parsed.DELIVERY_KEYRING_PROVIDER === "secret_manager") !== hasDeliveryReference) {
    throw new Error("delivery secret_manager and keyring reference must be configured together");
  }
  const hasFromConfiguration = isConfigured(parsed.EMAIL_FROM_ADDRESS) || isConfigured(parsed.EMAIL_FROM_NAME) || isConfigured(parsed.EMAIL_REPLY_TO_ADDRESS);
  if (parsed.EMAIL_DELIVERY_PROVIDER === "disabled" && hasFromConfiguration) {
    throw new Error("disabled email delivery rejects partial sender configuration");
  }
  if (parsed.EMAIL_DELIVERY_PROVIDER !== "disabled" && parsed.DELIVERY_KEYRING_PROVIDER === "disabled") {
    throw new Error("email delivery requires an enabled delivery keyring");
  }
  if (parsed.EMAIL_DELIVERY_PROVIDER === "mailpit") {
    const port = Number.parseInt(parsed.MAILPIT_SMTP_PORT ?? "", 10);
    if ((parsed.APP_ENVIRONMENT !== "development" && parsed.APP_ENVIRONMENT !== "test") || !isConfigured(parsed.MAILPIT_SMTP_HOST) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Mailpit requires complete development or test configuration");
    }
  }
  if (parsed.EMAIL_DELIVERY_PROVIDER === "resend") {
    if (!isConfigured(parsed.EMAIL_FROM_ADDRESS) || !isConfigured(parsed.EMAIL_FROM_NAME) || !z.string().email().safeParse(parsed.EMAIL_FROM_ADDRESS).success) {
      throw new Error("Resend requires a valid sender address and name");
    }
  }
}

export function loadRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  const parsed = baseRuntimeSchema.parse(environment);
  assertCanonicalOrigin(parsed.APP_PUBLIC_ORIGIN, parsed.APP_ENVIRONMENT);
  assertNoPaidComposition(parsed);
  assertCredentialPolicy(parsed);
  assertKisBase(parsed);
  assertVaultPolicy(parsed);
  assertIdentityPolicy(parsed);
  assertDeliveryPolicy(parsed);
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
    identityPersistence: parsed.IDENTITY_PERSISTENCE,
    credentialVaultProvider: parsed.CREDENTIAL_VAULT_PROVIDER,
    credentialLocalKeyringFile: parsed.CREDENTIAL_LOCAL_KEYRING_FILE,
    syntheticProviderEnabled: parsed.ENABLE_SYNTHETIC_PROVIDER,
    identityProviders: [
      ...(parsed.GOOGLE_IDENTITY_ENABLED ? ["google" as const] : []),
      ...(parsed.GITHUB_IDENTITY_ENABLED ? ["github" as const] : []),
    ],
    deliveryKeyringProvider: parsed.DELIVERY_KEYRING_PROVIDER,
    deliveryLocalKeyringFile: parsed.DELIVERY_LOCAL_KEYRING_FILE,
    emailDeliveryProvider: parsed.EMAIL_DELIVERY_PROVIDER,
  };
}
