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

interface AuthState {
  user: ApiUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<boolean>;
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
  const [error, setError] = useState<string | null>(null);

  const fetchUser = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    dropStoredCredentials();
    fetchUser().finally(() => setIsLoading(false));
  }, [fetchUser]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      setError(null);

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data);
        return true;
      }

      setError("Invalid credentials");
      return false;
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }, []);

  const onUnauthorized = useCallback(() => setUser(null), []);

  // Preferences saved elsewhere in the app have to reach the cached user, or a
  // client-side navigation keeps rendering the value from page load
  const refreshUser = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  const isAdmin = user?.role === "admin";

  return useMemo(
    () => ({ user, isAdmin, isLoading, error, login, logout, refreshUser, onUnauthorized }),
    [user, isAdmin, isLoading, error, login, logout, refreshUser, onUnauthorized]
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
