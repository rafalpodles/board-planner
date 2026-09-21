"use client";

import { useEffect, useState } from "react";
import { useApi } from "./use-api";
import { can, FeatureKey, Plan } from "@/lib/entitlements";

interface EntitlementApiResponse {
  plan: Plan;
  features: string[];
  expiresAt: string | null;
}

interface EntitlementState {
  loading: boolean;
  entitled: boolean;
}

export function useEntitlement(feature: FeatureKey): EntitlementState {
  const api = useApi();
  const [state, setState] = useState<EntitlementState>({ loading: true, entitled: false });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, entitled: false });

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
        setState({ loading: false, entitled });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, entitled: false });
      });

    return () => {
      cancelled = true;
    };
  }, [api, feature]);

  return state;
}
