"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

export function YourData({ asksPassword }: { asksPassword: boolean }) {
  const api = useApi();
  const { logout } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function download() {
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch("/api/users/me/export");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setDownloadError(body?.error ?? `Your data could not be downloaded (${response.status}).`);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "my-data.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Your data could not be downloaded. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  }

  function close() {
    setOpen(false);
    setPassword("");
    setDeleteError("");
  }

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.del("/api/users/me", asksPassword ? { currentPassword: password } : {});
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Your account could not be deleted.");
      setDeleting(false);
      return;
    }
    const signIn = await logout();
    window.location.assign(signIn ?? "/login");
  }

  return (
    <section className="mt-10 border-t border-border pt-6" aria-labelledby="your-data">
      <h3 id="your-data" className="text-base font-semibold mb-1">
        Your data
      </h3>
      <p className="text-sm text-text-muted mb-4">
        Download what this account holds about you: your details, your comments, the tasks you created, the changes
        you made to tasks, your conversations with the PM agent, your personal agents and your sign-in sessions.
      </p>
      <Button variant="secondary" onClick={() => void download()} disabled={downloading} aria-busy={downloading}>
        {downloading ? "Preparing…" : "Download my data"}
      </Button>
      {downloadError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {downloadError}
        </p>
      )}

      <p className="text-sm text-text-muted mt-6 mb-4">
        Deleting your account cannot be undone. Comments and history you wrote stay on the boards they belong to,
        under &ldquo;Deleted user&rdquo;; your notifications, PM conversations, personal agents and sign-in credentials are removed.
      </p>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete my account
      </Button>

      <Modal open={open} onClose={close} closeDisabled={deleting} title="Delete your account?">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!deleting && (!asksPassword || password)) void deleteAccount();
          }}
        >
          <p className="text-sm text-text-muted mb-4">
            You will be signed out and nobody, you included, can get this account back.
            {asksPassword
              ? " Enter your password to confirm."
              : " You need to have signed in within the last 10 minutes."}
          </p>
          {asksPassword && (
            <Input
              label="Current password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          )}
          {deleteError && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {deleteError}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={close} disabled={deleting}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" size="sm" disabled={deleting || (asksPassword && !password)}>
              {deleting ? "Deleting…" : "Delete my account"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
