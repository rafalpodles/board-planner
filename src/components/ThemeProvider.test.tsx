// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  ThemeProvider,
  useTheme,
  resolveTheme,
  readStoredPreference,
  THEME_STORAGE_KEY,
} from "./ThemeProvider";

let prefersDark = false;
let listeners: Array<() => void> = [];

function mockMatchMedia() {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("dark") ? prefersDark : !prefersDark;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  })) as unknown as typeof window.matchMedia;
}

function setSystemPrefersDark(next: boolean) {
  prefersDark = next;
  act(() => listeners.forEach((fn) => fn()));
}

function Probe() {
  const { theme, preference } = useTheme();
  return <span data-testid="probe">{`${preference}:${theme}`}</span>;
}

function ThemeSetter({ to }: { to: "dark" | "light" | "system" }) {
  const { setPreference } = useTheme();
  return <button onClick={() => setPreference(to)}>set</button>;
}

function state() {
  return screen.getByTestId("probe").textContent;
}

beforeEach(() => {
  prefersDark = false;
  listeners = [];
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockMatchMedia();
});

afterEach(cleanup);

describe("resolveTheme", () => {
  it("follows the system query only for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("readStoredPreference", () => {
  it("defaults to system when nothing is stored", () => {
    expect(readStoredPreference()).toBe("system");
  });

  it("keeps an explicitly stored choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readStoredPreference()).toBe("light");
  });

  it("falls back to system for a value it does not recognise", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "solarized");
    expect(readStoredPreference()).toBe("system");
  });
});

describe("ThemeProvider", () => {
  it("starts a new user on system and resolves it against the OS", () => {
    prefersDark = true;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(state()).toBe("system:dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("follows the OS live while on system", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(state()).toBe("system:light");

    setSystemPrefersDark(true);
    expect(state()).toBe("system:dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores the OS once a theme is chosen explicitly", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(state()).toBe("light:light");

    setSystemPrefersDark(true);
    expect(state()).toBe("light:light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stores the preference rather than the theme it resolved to", () => {
    prefersDark = true;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("persists a choice made through setPreference", () => {
    render(
      <ThemeProvider>
        <Probe />
        <ThemeSetter to="dark" />
      </ThemeProvider>
    );

    act(() => screen.getByText("set").click());

    expect(state()).toBe("dark:dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("stops following the OS after switching from system to explicit", () => {
    render(
      <ThemeProvider>
        <Probe />
        <ThemeSetter to="light" />
      </ThemeProvider>
    );
    act(() => screen.getByText("set").click());

    setSystemPrefersDark(true);
    expect(state()).toBe("light:light");
  });

  it("adopts the theme the inline script already applied", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(state()).toBe("dark:dark");
  });

  it("survives localStorage throwing, as it does in private mode", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() =>
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      )
    ).not.toThrow();
    expect(state()).toBe("system:light");

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
