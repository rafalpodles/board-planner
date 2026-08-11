"use client";

import { useAuth } from "./use-auth";
import { useCallback, useMemo } from "react";

interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export function useApi() {
  const { onUnauthorized } = useAuth();

  const request = useCallback(
    async (method: string, url: string, opts?: ApiOptions) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...opts?.headers,
      };

      const res = await fetch(url, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      });

      if (!res.ok) {
        if (res.status === 401) onUnauthorized();
        const error = await res.json().catch(() => ({ error: res.statusText }));
        // Message stays the whole error for every existing caller; status and body ride along
        // for the few that need to tell one refusal from another rather than just report it
        throw Object.assign(new Error(error.error || res.statusText), {
          status: res.status,
          body: error,
        });
      }

      return res.json();
    },
    [onUnauthorized]
  );

  const upload = useCallback(
    async (url: string, formData: FormData) => {
      const res = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        if (res.status === 401) onUnauthorized();
        const error = await res.json().catch(() => ({ error: res.statusText }));
        // Message stays the whole error for every existing caller; status and body ride along
        // for the few that need to tell one refusal from another rather than just report it
        throw Object.assign(new Error(error.error || res.statusText), {
          status: res.status,
          body: error,
        });
      }

      return res.json();
    },
    [onUnauthorized]
  );

  // Raw streaming POST (SSE): returns the Response so callers can read the body
  const stream = useCallback(
    async (url: string, body: unknown): Promise<Response> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) onUnauthorized();
      return res;
    },
    [onUnauthorized]
  );

  const get = useCallback((url: string) => request("GET", url), [request]);
  const post = useCallback((url: string, body: unknown) => request("POST", url, { body }), [request]);
  const put = useCallback((url: string, body: unknown) => request("PUT", url, { body }), [request]);
  const patch = useCallback((url: string, body: unknown) => request("PATCH", url, { body }), [request]);
  const del = useCallback((url: string, body?: unknown) => request("DELETE", url, { body }), [request]);

  return useMemo(
    () => ({ get, post, put, patch, del, upload, stream }),
    [get, post, put, patch, del, upload, stream]
  );
}
