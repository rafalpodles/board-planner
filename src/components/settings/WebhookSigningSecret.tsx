"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import type { WebhookSigning } from "@/app/api/projects/[projectId]/webhooks/signing-secret/route";

export function WebhookSigningSecret({ projectId }: { projectId: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [signing, setSigning] = useState<WebhookSigning | null>(null);
  const [copied, setCopied] = useState(false);

  async function show() {
    try {
      setSigning(await api.get(`/api/projects/${projectId}/webhooks/signing-secret`));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not read the signing secret", "error");
    }
  }

  async function copy(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the secret and copy it manually", "error");
    }
  }

  if (!signing) {
    return (
      <Button size="sm" variant="secondary" onClick={show}>
        Show signing secret
      </Button>
    );
  }
  if (signing.signing === "off") {
    return <p className="text-sm text-text-muted">Deliveries are unsigned: this instance has no signing secret.</p>;
  }
  if (signing.signing === "instance") {
    return <p className="text-sm text-text-muted">Deliveries are signed with this instance&apos;s WEBHOOK_SIGNING_SECRET.</p>;
  }
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <code
          data-testid="webhook-signing-secret"
          className="min-w-0 flex-1 select-all break-all rounded border border-border bg-bg px-3 py-2 text-sm"
        >
          {signing.secret}
        </code>
        <Button size="sm" variant="secondary" onClick={() => copy(signing.secret)}>
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">Your organisation&apos;s key for verifying deliveries.</p>
    </div>
  );
}
