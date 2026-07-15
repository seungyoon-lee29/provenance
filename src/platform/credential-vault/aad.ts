import type { CredentialAadContext } from "./types";

function encodePart(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(data.byteLength);
  return Buffer.concat([size, data]);
}

export function encodeCredentialAad(context: CredentialAadContext): Uint8Array {
  return Buffer.concat([
    encodePart("fakebloomberg/credential-vault/v1"),
    encodePart(context.purpose),
    encodePart(context.workspaceReference),
    encodePart(context.providerConnectionReference),
    encodePart(context.provider),
    encodePart(context.credentialType),
    encodePart(context.environment),
  ]);
}
