import { afterEach, describe, expect, it, vi } from "vitest";
import bootstrap from "../../public/theme-init.js?raw";
import { parseTheme, readPreference, removePreference, resolveTheme, writePreference } from "./preferences";

afterEach(() => vi.unstubAllGlobals());
describe("optional UI preferences", () => {
  it("preserves old explicit themes and defaults invalid values to system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    for (const value of [null, undefined, "", "broken", "system"]) expect(parseTheme(value)).toBe("system");
    expect(resolveTheme("system", true)).toBe(true);
    expect(resolveTheme("system", false)).toBe(false);
    expect(resolveTheme("light", true)).toBe(false);
    expect(resolveTheme("dark", false)).toBe(true);
  });
  it("does not block the app when storage access is denied", () => {
    const fail = () => { throw new Error("SecurityError"); };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    expect(readPreference("novel-theme")).toBe(null);
    expect(() => writePreference("novel-theme", "dark")).not.toThrow();
    expect(() => removePreference("novel-theme")).not.toThrow();
  });
  it.each(["light", "dark", "system", null, "invalid"])("pre-paint bootstrap agrees with React for %s", (value) => {
    for (const systemDark of [true, false]) {
      const toggle = vi.fn();
      const style: Record<string, string> = {};
      const initialize = new Function("localStorage", "matchMedia", "document", bootstrap);
      initialize({ getItem: () => value }, () => ({ matches: systemDark }), {
        documentElement: { classList: { toggle }, style }
      });
      const dark = resolveTheme(parseTheme(value), systemDark);
      expect(toggle).toHaveBeenCalledWith("dark", dark);
      expect(style.colorScheme).toBe(dark ? "dark" : "light");
    }
  });
});
