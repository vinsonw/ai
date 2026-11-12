import { describe, expect, it } from "vitest";
import { repoPathsEquivalent } from "../../src/path-utils.js";

describe("workflow session repo match", () => {
  it("accepts mixed slash roots on Windows", () => {
    if (process.platform !== "win32") return;
    expect(repoPathsEquivalent("C:\\repo\\app", "C:/repo/app")).toBe(true);
  });

  it("rejects different roots", () => {
    expect(repoPathsEquivalent("/tmp/a", "/tmp/b")).toBe(false);
  });
});
