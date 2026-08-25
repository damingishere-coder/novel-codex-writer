import { describe, expect, it } from "vitest";
import { ApiError } from "./file-storage";
import { configureErrorRedactionRoots, getErrorCode, redactErrorMessage } from "./http-error";

describe("HTTP error mapping", () => {
  it("preserves stable ApiError codes", () => {
    expect(getErrorCode(new ApiError(409, "conflict", "REVISION_CONFLICT"))).toBe("REVISION_CONFLICT");
    expect(getErrorCode(new Error("unknown"))).toBe("INTERNAL_ERROR");
  });

  it("redacts configured paths and credential-shaped values", () => {
    configureErrorRedactionRoots(["C:\\private\\library"]);
    const value = redactErrorMessage(
      'C:\\private\\library\\chapter.md Bearer abc.def token=topsecret key=visible {"apiKey":"json-secret","client_secret":"part\\\"tail"}'
    );
    expect(value).not.toContain("private");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("visible");
    expect(value).not.toContain("json-secret");
    expect(value).not.toContain("part");
    expect(value).not.toContain("tail");
  });
});
