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

const WHO_AM_I_TIMEOUT_MS = 8_000;

export interface AuthState {
  user: ApiUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  outage: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  onUnauthorized: () => void;
  noteApiStatus: (status: number) => void;
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
      const res = await fetch("/api/auth/me", {
        signal: AbortSignal.timeout(WHO_AM_I_TIMEOUT_MS),
      });
      if (res.ok) {
        setUser(await res.json());
        setOutage(false);
        return;
      }
      if (res.status === 401) setUser(null);
      setOutage(res.status >= 500);
    } catch {
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

  const onUnauthorized = useCallback(() => {
    setUser(null);
    setOutage(false);
  }, []);

  const noteApiStatus = useCallback((status: number) => {
    setOutage(status >= 500);
  }, []);

  const refreshUser = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  const isAdmin = user?.role === "admin";

  return useMemo(
    () => ({
      user,
      isAdmin,
      isLoading,
      outage,
      login,
      logout,
      refreshUser,
      onUnauthorized,
      noteApiStatus,
    }),
    [user, isAdmin, isLoading, outage, login, logout, refreshUser, onUnauthorized, noteApiStatus]
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
