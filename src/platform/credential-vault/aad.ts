import type { CredentialAadContext } from "./types";

function encodePart(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(data.byteLength);
  return Buffer.concat([size, data]);
}

export function encodeCredentialAad(context: CredentialAadContext): Uint8Array {
  return Buffer.concat([
    // 이름 변경(fakebloomberg → provenance) 시에도 이 AAD 문자열은 고정한다.
    // 바꾸면 기존 암호문을 복호화할 수 없다. 변경이 필요하면 /v2 로 버전을 올리고 재암호화 마이그레이션을 동반해야 한다.
    encodePart("fakebloomberg/credential-vault/v1"),
    encodePart(context.purpose),
    encodePart(context.workspaceReference),
    encodePart(context.providerConnectionReference),
    encodePart(context.provider),
    encodePart(context.credentialType),
    encodePart(context.environment),
  ]);
}
