import { identityServer } from "@/composition/identity-server";
import { SignInForm } from "./signin-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ error?: string }> }>) {
  const { error } = await searchParams;
  // Spec §13.1: only providers that are enabled AND fully configured are "ready" — offer a button
  // for those only. Real OAuth is opt-in; in the default dev/test config no provider is ready, so
  // email is the sole path (the scripted federated routes remain wired for the opt-in case).
  const providers = identityServer().config.identityProviders;
  return <SignInForm initialError={error === "1"} providers={providers} />;
}
