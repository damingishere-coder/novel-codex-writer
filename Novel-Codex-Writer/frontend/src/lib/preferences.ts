// UI preferences are optional: blocked storage must never prevent writing.
export function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Session-only preferences. */ }
}

export function removePreference(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

export const recentDocumentKey = (projectId: string) => `novel-recent-document:${projectId}`;

export type ThemePreference = "light" | "dark" | "system";
export function parseTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  return preference === "system" ? systemDark : preference === "dark";
}
