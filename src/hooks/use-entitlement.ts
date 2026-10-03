"use client";

import { useEffect, useState } from "react";
import { useApi } from "./use-api";
import { can, FeatureKey, Plan } from "@/lib/entitlements";

interface EntitlementApiResponse {
  plan: Plan;
  features: string[];
  expiresAt: string | null;
}

export interface EntitlementState {
  loading: boolean;
  entitled: boolean;
  /** The plan could not be read; `entitled` is false, which is not the same as "not on Pro" */
  error: boolean;
}

export function useEntitlement(feature: FeatureKey): EntitlementState {
  const api = useApi();
  const [state, setState] = useState<EntitlementState>({ loading: true, entitled: false, error: false });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, entitled: false, error: false });

    api
      .get("/api/entitlements")
      .then((data: EntitlementApiResponse) => {
        if (cancelled) return;
        const entitled = can(
          {
            entitlements: {
              plan: data.plan,
              features: data.features,
              expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
            },
          },
          feature
        );
        setState({ loading: false, entitled, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, entitled: false, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [api, feature]);

  return state;
}
