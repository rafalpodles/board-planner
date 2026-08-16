"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface EmailSettings {
  configured: boolean;
  host: string;
  port: number;
  user: string;
  from: string;
}

export default function EmailSettingsPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    heading: string;
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await api.get("/api/admin/email"));
    } catch {
      toast("Failed to read the mail settings", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }
    load();
  }, [isAdmin, authLoading, router, load]);

  async function handleTest() {
    setSending(true);
    setResult(null);
    try {
      const res: { to: string } = await api.post("/api/admin/email", {});
      setResult({
        ok: true,
        heading: "The mail server accepted it",
        message: `Accepted for delivery to ${res.to}.`,
      });
    } catch (err) {
      // A refusal by the mail server and a refusal by us are different answers to the question the
      // admin asked, and saying the server refused when it was never contacted sends them to the
      // wrong place to look
      const status = (err as { status?: number })?.status;
      setResult({
        ok: false,
        heading: status === 502 ? "The mail server refused it" : "Nothing was sent",
        message: err instanceof Error ? err.message : "The message could not be sent",
      });
    } finally {
      setSending(false);
    }
  }

  if (authLoading || settings === null) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin) return null;

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Email</h2>
      <p className="text-sm text-text-muted mb-6">
        Set from the environment, not from here — a deployment&apos;s mail server is a deployment
        decision. This screen says whether it works.
      </p>

      {settings.configured ? (
        <dl className="mb-6 divide-y divide-border rounded-lg border border-border text-sm">
          {[
            ["Server", `${settings.host}:${settings.port}`],
            ["Username", settings.user],
            ["Messages come from", settings.from],
          ].map(([label, value]) => (
            <div key={label} className="flex gap-4 px-4 py-2">
              <dt className="w-48 shrink-0 text-text-muted">{label}</dt>
              <dd className="min-w-0 break-all">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="mb-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">No mail server is configured.</p>
          <p className="mt-1 text-text-muted">
            Set <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASS</code> in the
            environment and restart. Until then nobody can be sent a password reset, and email
            notifications are silently skipped.
          </p>
        </div>
      )}

      <Button onClick={handleTest} disabled={sending || !settings.configured}>
        {sending ? "Sending…" : "Send a test message"}
      </Button>
      <p className="mt-2 text-sm text-text-muted">
        It goes to the address on{" "}
        <Link href="/settings/profile" className="underline">
          your own profile
        </Link>{" "}
        and nowhere else.
      </p>

      {result && (
        <div
          className={`mt-4 rounded-lg border p-4 text-sm ${
            result.ok ? "border-border" : "border-danger"
          }`}
        >
          <p className={result.ok ? "font-medium" : "font-medium text-danger"}>{result.heading}</p>
          <p className="mt-1 break-words text-text-muted">{result.message}</p>
          {result.ok && (
            <p className="mt-1 text-text-muted">
              Accepted is not delivered — if it does not arrive, the rejection happened after the
              handover and will be in your provider&apos;s own log.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
