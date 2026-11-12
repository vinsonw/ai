import { describe, expect, it } from "vitest";
import { posixifyRepoRelativePath, relativePosix } from "../../src/path-utils.js";

describe("relativePosix", () => {
  it("unifies Windows-style relative segments", () => {
    expect(relativePosix("docs\\可读化\\index.md")).toBe("docs/可读化/index.md");
  });
});

describe("posixifyRepoRelativePath", () => {
  it("normalizes git status paths on Windows", () => {
    expect(posixifyRepoRelativePath("docs\\可读化\\README.md")).toBe("docs/可读化/README.md");
  });
});
