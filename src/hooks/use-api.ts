"use client";

import { useAuth } from "./use-auth";
import { useCallback } from "react";

interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export function useApi() {
  const { getAuthHeader } = useAuth();

  const request = useCallback(
    async (method: string, url: string, opts?: ApiOptions) => {
      const authHeader = getAuthHeader();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...opts?.headers,
      };

      if (authHeader) {
        headers["Authorization"] = authHeader;
      }

      const res = await fetch(url, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(error.error || res.statusText);
      }

      return res.json();
    },
    [getAuthHeader]
  );

  return {
    get: (url: string) => request("GET", url),
    post: (url: string, body: unknown) => request("POST", url, { body }),
    put: (url: string, body: unknown) => request("PUT", url, { body }),
    patch: (url: string, body: unknown) => request("PATCH", url, { body }),
    del: (url: string, body?: unknown) => request("DELETE", url, { body }),
  };
}
