import { useEffect, useState } from "react";
import { parseTheme, readPreference, resolveTheme, writePreference, type ThemePreference } from "../lib/preferences";

export function useTheme() {
  const [themePreference, setPreference] = useState(() => parseTheme(readPreference("novel-theme")));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const dark = resolveTheme(themePreference, systemDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    const sync = (event: StorageEvent) => {
      if (event.key === "novel-theme" || event.key === null) setPreference(parseTheme(readPreference("novel-theme")));
    };
    update();
    media.addEventListener("change", update);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  function setThemePreference(value: ThemePreference) {
    writePreference("novel-theme", value);
    setPreference(value);
  }
  return { dark, themePreference, setThemePreference };
}
