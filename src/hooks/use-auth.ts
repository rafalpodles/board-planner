"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { ApiUser } from "@/types";

export type LoginResult = { ok: true } | { ok: false; reason: string };

const UNREACHABLE =
  "Cannot reach the server right now. Your account is fine — try again in a moment.";

interface AuthState {
  user: ApiUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  /**
   * The server could not answer, which is not the same as nobody being signed in.
   *
   * Kept apart from `user` because the guard redirects on `!user`, and the sign-in page it
   * redirects to is served by the same instance that just failed — so folding the two together
   * turned a database outage into a logout nobody could undo (BP-362).
   */
  outage: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  onUnauthorized: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export { AuthContext };

function dropStoredCredentials() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem("auth_credentials");
  localStorage.removeItem("auth_credentials");
}

export function useAuthProvider(): AuthState {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [outage, setOutage] = useState(false);

  const fetchUser = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        setUser(await res.json());
        setOutage(false);
        return;
      }
      // Only a 401 is evidence about the session. A 5xx says the answer never arrived.
      setOutage(res.status >= 500);
    } catch {
      // The request did not complete at all — the same class of thing as a 503, and equally not
      // a signed-out state
      setOutage(true);
    }
  }, []);

  useEffect(() => {
    dropStoredCredentials();
    fetchUser().finally(() => setIsLoading(false));
  }, [fetchUser]);

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResult> => {
      let res: Response;
      try {
        res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
      } catch {
        setOutage(true);
        return { ok: false, reason: UNREACHABLE };
      }

      if (res.ok) {
        setUser(await res.json());
        setOutage(false);
        return { ok: true };
      }

      const body = await res.json().catch(() => null);
      const reason = typeof body?.error === "string" ? body.error : null;

      // The server's own words, so a locked-out account and an unreachable database each say what
      // they are. Flattening every failure to "Invalid credentials" is what made an outage look
      // like a bad password.
      if (res.status >= 500) {
        setOutage(true);
        return { ok: false, reason: reason ?? UNREACHABLE };
      }

      setOutage(false);
      return { ok: false, reason: reason ?? "Invalid credentials" };
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    setOutage(false);
  }, []);

  const onUnauthorized = useCallback(() => setUser(null), []);

  // Preferences saved elsewhere in the app have to reach the cached user, or a
  // client-side navigation keeps rendering the value from page load
  const refreshUser = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  const isAdmin = user?.role === "admin";

  return useMemo(
    () => ({ user, isAdmin, isLoading, outage, login, logout, refreshUser, onUnauthorized }),
    [user, isAdmin, isLoading, outage, login, logout, refreshUser, onUnauthorized]
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
