"use client";

import { useAuth } from "./use-auth";
import { useCallback, useMemo } from "react";

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

  const upload = useCallback(
    async (url: string, formData: FormData) => {
      const authHeader = getAuthHeader();
      const headers: Record<string, string> = {};
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(error.error || res.statusText);
      }

      return res.json();
    },
    [getAuthHeader]
  );

  const get = useCallback((url: string) => request("GET", url), [request]);
  const post = useCallback((url: string, body: unknown) => request("POST", url, { body }), [request]);
  const put = useCallback((url: string, body: unknown) => request("PUT", url, { body }), [request]);
  const patch = useCallback((url: string, body: unknown) => request("PATCH", url, { body }), [request]);
  const del = useCallback((url: string, body?: unknown) => request("DELETE", url, { body }), [request]);

  return useMemo(
    () => ({ get, post, put, patch, del, upload }),
    [get, post, put, patch, del, upload]
  );
}
