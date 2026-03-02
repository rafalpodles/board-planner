"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { ApiUser } from "@/types";

interface AuthState {
  user: ApiUser | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  getAuthHeader: () => string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export { AuthContext };

function encodeCredentials(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

export function useAuthProvider(): AuthState {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getAuthHeader = useCallback((): string | null => {
    if (typeof window === "undefined") return null;
    const creds = sessionStorage.getItem("auth_credentials");
    return creds ? `Basic ${creds}` : null;
  }, []);

  const fetchUser = useCallback(async (authHeader: string) => {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: authHeader },
      });
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
    const header = getAuthHeader();
    if (header) {
      fetchUser(header).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [fetchUser, getAuthHeader]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      setError(null);
      const encoded = encodeCredentials(username, password);
      const header = `Basic ${encoded}`;

      const res = await fetch("/api/auth/me", {
        headers: { Authorization: header },
      });

      if (res.ok) {
        sessionStorage.setItem("auth_credentials", encoded);
        const data = await res.json();
        setUser(data);
        return true;
      }

      setError("Invalid credentials");
      return false;
    },
    []
  );

  const logout = useCallback(() => {
    sessionStorage.removeItem("auth_credentials");
    setUser(null);
  }, []);

  return { user, isLoading, error, login, logout, getAuthHeader };
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
