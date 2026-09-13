"use client";

import { useAuth } from "./use-auth";
import { useCallback, useMemo } from "react";

interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** This endpoint answers 502 for "a third party refused", not for its own health (BP-607) */
  relayed?: boolean;
}

export function useApi() {
  const { onUnauthorized, noteApiStatus } = useAuth();

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

      // 502 and no other status: that is the one this endpoint speaks for somebody else with. A
      // 503 from the same route is the middleware answering for this instance, database and all,
      // and the shell still has to hear it.
      noteApiStatus(res.status, { relayed: opts?.relayed === true && res.status === 502 });

      if (!res.ok) {
        // Only a 401. A 5xx means the server could not answer, and clearing the session on that is
        // what turned an outage into a logout (BP-362).
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
    [onUnauthorized, noteApiStatus]
  );

  const upload = useCallback(
    async (url: string, formData: FormData) => {
      const res = await fetch(url, {
        method: "POST",
        body: formData,
      });

      noteApiStatus(res.status);

      if (!res.ok) {
        // Only a 401. A 5xx means the server could not answer, and clearing the session on that is
        // what turned an outage into a logout (BP-362).
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
    [onUnauthorized, noteApiStatus]
  );

  // Raw streaming POST (SSE): returns the Response so callers can read the body
  const stream = useCallback(
    async (url: string, body: unknown): Promise<Response> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      noteApiStatus(res.status);
      if (res.status === 401) onUnauthorized();
      return res;
    },
    [onUnauthorized, noteApiStatus]
  );

  const get = useCallback((url: string) => request("GET", url), [request]);
  const post = useCallback(
    (url: string, body: unknown, opts?: { relayed?: boolean }) =>
      request("POST", url, { body, relayed: opts?.relayed }),
    [request]
  );
  const put = useCallback((url: string, body: unknown) => request("PUT", url, { body }), [request]);
  const patch = useCallback((url: string, body: unknown) => request("PATCH", url, { body }), [request]);
  const del = useCallback((url: string, body?: unknown) => request("DELETE", url, { body }), [request]);

  return useMemo(
    () => ({ get, post, put, patch, del, upload, stream }),
    [get, post, put, patch, del, upload, stream]
  );
}
