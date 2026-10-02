"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export interface LinkedIdentity {
  _id: string;
  provider: string;
  label: string;
  email: string;
  linkedAt: string;
  lastUsedAt: string | null;
}

export function SignInMethods({
  identities,
  onChanged,
}: {
  identities: LinkedIdentity[];
  onChanged: () => void;
}) {
  const api = useApi();
  const { toast } = useToast();
  const [unlinking, setUnlinking] = useState<LinkedIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function unlink() {
    if (!unlinking || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.del(`/api/users/me/identities/${unlinking._id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "It could not be unlinked");
      setBusy(false);
      return;
    }
    setBusy(false);
    toast(`${unlinking.label} unlinked`, "success");
    setUnlinking(null);
    onChanged();
  }

  if (identities.length === 0) return null;

  return (
    <section className="mt-10" aria-labelledby="sign-in-methods">
      <h2 id="sign-in-methods" className="text-lg font-semibold mb-3">
        Sign-in providers
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {identities.map((identity) => (
          <li key={identity._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{identity.label}</p>
              <p className="text-xs text-text-muted break-all">{identity.email}</p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Unlink ${identity.label}`}
              onClick={() => {
                setError("");
                setUnlinking(identity);
              }}
            >
              Unlink
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!unlinking}
        onClose={() => setUnlinking(null)}
        onConfirm={unlink}
        title="Unlink sign-in provider"
        message={`You will no longer sign in here with ${unlinking?.label ?? ""}.`}
        confirmLabel="Unlink"
        loadingLabel="Unlinking…"
        loading={busy}
        error={error}
      />
    </section>
  );
}
