"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
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
  const { user: currentUser, isAdmin, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    heading: string;
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setSettings(await api.get("/api/admin/email"));
    } catch {
      toast("Failed to read the mail settings", "error");
      // Never the unconfigured state: telling an admin whose SMTP works to set three environment
      // variables and restart is a destructive-adjacent instruction given on no evidence
      setFailed(true);
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
      setResult({ ok: true, heading: `Accepted for delivery to ${res.to}`, message: "" });
    } catch (err) {
      // A refusal by the mail server and a refusal by us are different answers to the question the
      // admin asked, and saying the server refused when it was never contacted sends them to the
      // wrong place to look. Only 502 is the server's own answer.
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

  if (authLoading || (settings === null && !failed)) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin) return null;

  if (failed || settings === null) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1">Email</h2>
        <p className="text-sm text-text-muted mb-6">
          Configured in the environment, not here. This screen shows whether it works.
        </p>
        <LoadFailed
          testId="email-settings-error"
          message="Failed to read the mail settings, so this page cannot say whether one is configured."
          onRetry={load}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Email</h2>
      <p className="text-sm text-text-muted mb-6">
        Configured in the environment, not here. This screen shows whether it works.
      </p>

      {settings.configured ? (
        <dl className="mb-6 divide-y divide-border rounded-lg border border-border text-sm">
          {[
            ["Server", `${settings.host}:${settings.port}`],
            ["Username", settings.user],
            ["From", settings.from],
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
            environment, then restart. Until then no email is sent.
          </p>
        </div>
      )}

      <Button
        onClick={handleTest}
        disabled={sending || !settings.configured || !currentUser?.email}
      >
        {sending ? "Sending…" : "Send a test message"}
      </Button>
      {/* Naming the address is also how the page stops offering a button that can only fail:
          without one the server refuses, and a round trip to learn that is a round trip wasted */}
      <p className="mt-2 text-sm text-text-muted">
        {currentUser?.email ? (
          `It goes to ${currentUser.email}, the address on your profile.`
        ) : (
          <>
            Add an address to{" "}
            <Link href="/settings/profile" className="underline">
              your profile
            </Link>{" "}
            first — the test goes there and nowhere else.
          </>
        )}
      </p>

      {result && (
        <div
          role={result.ok ? "status" : "alert"}
          className={`mt-4 rounded-lg border p-4 text-sm ${
            result.ok ? "border-border" : "border-danger"
          }`}
        >
          <p className={result.ok ? "font-medium" : "font-medium text-danger"}>{result.heading}</p>
          {result.message && (
            <p className="mt-1 break-words text-text-muted">{result.message}</p>
          )}
          {result.ok && (
            <p className="mt-1 text-text-muted">
              If it does not arrive, check the spam folder and your mail provider&apos;s logs.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
