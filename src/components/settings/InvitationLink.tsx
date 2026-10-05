"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { InvitationLinkReason } from "@/types";

const HEADLINE: Record<InvitationLinkReason, (email: string) => string> = {
  no_mail_server: (email) =>
    `No email was sent — this instance has no mail server. Send this link to ${email} yourself.`,
  mail_failed: (email) => `The email to ${email} could not be sent. Send this link yourself.`,
  requested: (email) => `No email was sent. Send this link to ${email} yourself.`,
};

export function InvitationLink({
  email,
  link,
  reason,
}: {
  email: string;
  link: string;
  reason: InvitationLinkReason;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the link and copy it manually", "error");
    }
  }

  return (
    <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 space-y-2">
      <p className="text-sm font-medium text-warning">
        {HEADLINE[reason](email)}
      </p>
      <div className="flex gap-2">
        <code
          data-testid="invitation-link"
          className="flex-1 min-w-0 bg-bg text-sm px-3 py-2 rounded border border-border break-all select-all"
        >
          {link}
        </code>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Shown once. It works for one sign-up and expires in seven days.
      </p>
    </div>
  );
}
