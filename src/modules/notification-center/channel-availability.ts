/**
 * F5 Alert Channel Availability (spec §11 line 333). Four independent axes are
 * preserved separately and synthesized into one status. The synthesis returns
 * the most fundamental blocker first: an unsupported platform can't be fixed by
 * configuration, configuration must precede asking for device permission, and a
 * quota/circuit block is only meaningful once the channel is otherwise usable.
 * When no external channel is configured the in-app inbox still works; the
 * channel simply reports `configuration_required` (spec lines 335/512).
 */
export type ChannelAvailability =
  | "ready"
  | "configuration_required"
  | "unsupported"
  | "permission_denied"
  | "quota_blocked";

export type ChannelAvailabilityAxes = Readonly<{
  /** The platform/device can support the channel at all (e.g. service worker for web push). */
  supported: boolean;
  /** Operator deployment is complete (Resend owned domain + keyring, or VAPID). */
  deploymentReady: boolean;
  /** Workspace has opted in and has a verified address / registered subscription target. */
  consentAndAddressReady: boolean;
  /** Device permission / push subscription is currently granted. */
  permissionGranted: boolean;
  /** Category quota remains and the delivery circuit is closed. */
  quotaAvailable: boolean;
}>;

export function synthesizeChannelAvailability(axes: ChannelAvailabilityAxes): ChannelAvailability {
  if (!axes.supported) return "unsupported";
  if (!axes.deploymentReady || !axes.consentAndAddressReady) return "configuration_required";
  if (!axes.permissionGranted) return "permission_denied";
  if (!axes.quotaAvailable) return "quota_blocked";
  return "ready";
}
