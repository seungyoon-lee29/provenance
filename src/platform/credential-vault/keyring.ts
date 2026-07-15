import type { VaultKeyVersion } from "../../shared/contracts";
import type { VaultKey } from "./types";

export class CredentialKeyring {
  readonly #active: VaultKey;
  readonly #keys: ReadonlyMap<VaultKeyVersion, VaultKey>;

  constructor(keys: readonly VaultKey[], private readonly now: () => Date = () => new Date()) {
    const ownedKeys = keys.map((key) => ({
      ...key,
      key: Uint8Array.from(key.key),
      ...(key.notAfter === undefined ? {} : { notAfter: new Date(key.notAfter.getTime()) }),
    }));
    const active = ownedKeys.filter((key) => key.status === "active");
    if (active.length !== 1 || active[0] === undefined) throw new Error("credential keyring requires exactly one active key");
    if (ownedKeys.some((key) => key.key.byteLength !== 32)) throw new Error("credential keyring contains an invalid key");
    if (active[0].notAfter !== undefined && active[0].notAfter.getTime() <= this.now().getTime()) throw new Error("credential keyring active key is expired");
    const byVersion = new Map(ownedKeys.map((key) => [key.version, key]));
    if (byVersion.size !== ownedKeys.length) throw new Error("credential keyring contains a duplicate version");
    this.#active = active[0];
    this.#keys = byVersion;
  }

  active(): VaultKey {
    return { ...this.#active, key: Uint8Array.from(this.#active.key), ...(this.#active.notAfter === undefined ? {} : { notAfter: new Date(this.#active.notAfter.getTime()) }) };
  }

  readable(version: VaultKeyVersion): VaultKey {
    const key = this.#keys.get(version);
    if (key === undefined || (key.notAfter !== undefined && key.notAfter.getTime() <= this.now().getTime())) {
      throw new Error("credential decryption unavailable");
    }
    return { ...key, key: Uint8Array.from(key.key), ...(key.notAfter === undefined ? {} : { notAfter: new Date(key.notAfter.getTime()) }) };
  }
}
