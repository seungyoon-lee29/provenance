/**
 * Purpose-bound Additional Authenticated Data for the delivery vaults
 * (spec §12 line 251, SEC-03/AT-11). The `kind` and `purpose` are folded into
 * the AAD, so a ciphertext sealed as a channel endpoint can never be opened as
 * an action material, and a challenge material can never be opened under an
 * unsubscribe purpose — an AAD field swap fails the GCM tag and the vault fails
 * closed. Each part is length-prefixed so field boundaries are unambiguous
 * (kind="a",purpose="bc" cannot collide with kind="ab",purpose="c").
 */
export type DeliveryAadKind = "channel_endpoint" | "action_material";

export type DeliveryAadContext = Readonly<{
  kind: DeliveryAadKind;
  /** e.g. workspace_financial_email | account_challenge | unsubscribe | authenticated_security_notice */
  purpose: string;
  /** The erasure subject that owns the secret — a workspace or a pending identity. */
  subject: string;
  /** The endpoint or action-material reference the ciphertext belongs to. */
  reference: string;
}>;

function encodePart(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(data.byteLength);
  return Buffer.concat([size, data]);
}

export function encodeDeliveryAad(context: DeliveryAadContext): Uint8Array {
  return Buffer.concat([
    // 이름 변경(fakebloomberg → provenance) 시에도 이 AAD 문자열은 고정한다.
    // 바꾸면 기존 암호문을 복호화할 수 없다. 변경이 필요하면 /v2 로 버전을 올리고 재암호화 마이그레이션을 동반해야 한다.
    encodePart("fakebloomberg/delivery-vault/v1"),
    encodePart(context.kind),
    encodePart(context.purpose),
    encodePart(context.subject),
    encodePart(context.reference),
  ]);
}
