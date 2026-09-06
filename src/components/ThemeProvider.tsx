"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ThemePreference = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  preference: "system",
  setPreference: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
  }
  return "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPreferenceState(readStoredPreference());
    const applied = document.documentElement.getAttribute("data-theme");
    if (applied === "light" || applied === "dark") setTheme(applied);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const media = window.matchMedia(DARK_QUERY);
    const apply = () => {
      const next = resolveTheme(preference, media.matches);
      setTheme(next);
      document.documentElement.setAttribute("data-theme", next);
    };

    apply();
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
    }

    if (preference !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference, mounted]);

  const setPreference = useCallback((next: ThemePreference) => setPreferenceState(next), []);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}
