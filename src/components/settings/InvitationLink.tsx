"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export function InvitationLink({
  email,
  link,
  reason,
}: {
  email: string;
  link: string;
  reason: "no_mail_server" | "mail_failed";
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
        {reason === "no_mail_server"
          ? `No email was sent — this instance has no mail server. Send this link to ${email} yourself.`
          : `The email to ${email} could not be sent. Send this link yourself.`}
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
