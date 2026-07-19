import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

type Shot = {
  file: string;
  scene: string;
  provenance: "synthetic" | "real_public_data";
  licenseScope: string;
  capturedBy: string;
  excludes: string[];
  status: "captured" | "ready-for-human";
};

const manifest = JSON.parse(readFileSync(resolve(ROOT, "tests/release/screenshot-manifest.json"), "utf8")) as {
  allowedLicenseScopes: string[];
  screenshots: Shot[];
};

describe("F11 screenshot provenance/rights manifest", () => {
  it("declares the four required release scenes", () => {
    expect(manifest.screenshots.map((shot) => shot.file).sort()).toEqual([
      "tests/browser/screenshots/explicit-unavailable.png",
      "tests/browser/screenshots/guest-desktop-public.png",
      "tests/browser/screenshots/guest-mobile-public.png",
      "tests/browser/screenshots/paper-workspace.png",
    ]);
  });

  it("carries provenance, an allowed license scope, and secret/PII exclusion for every scene", () => {
    for (const shot of manifest.screenshots) {
      expect(shot.scene.length).toBeGreaterThan(0);
      expect(shot.capturedBy.length).toBeGreaterThan(0);
      expect(manifest.allowedLicenseScopes).toContain(shot.licenseScope);
      expect(shot.excludes).toEqual(expect.arrayContaining(["secrets", "personal_account_detail"]));
    }
  });

  it("has every synthetic scene already captured on disk", () => {
    for (const shot of manifest.screenshots.filter((entry) => entry.provenance === "synthetic")) {
      expect(shot.status).toBe("captured");
      expect(existsSync(resolve(ROOT, shot.file))).toBe(true);
    }
  });

  it("marks the real public-data scenes ready-for-human (public scope, not yet captured)", () => {
    const publicShots = manifest.screenshots.filter((entry) => entry.provenance === "real_public_data");
    expect(publicShots).toHaveLength(2);
    for (const shot of publicShots) {
      expect(shot.licenseScope).toBe("public");
      expect(shot.status).toBe("ready-for-human");
    }
  });
});
