"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useToast } from "@/components/ui/Toast";
import { formatStorage } from "@/lib/storage-size";

interface StoredFile {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  project: { key: string; name: string } | null;
  uploadedBy: string | null;
}

interface Listing {
  total: number;
  files: StoredFile[];
}

export function StorageFiles({ onDeleted }: { onDeleted: () => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<StoredFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setFailed(false);
    try {
      setListing(await api.get("/api/organisation/storage/files"));
    } catch {
      setFailed(true);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && listing === null) void load();
  }

  async function remove(file: StoredFile) {
    setDeleting(true);
    try {
      await api.del(`/api/organisation/storage/files/${file.id}`);
      toast(`${file.name} deleted`, "success");
      setAsking(null);
      onDeleted();
      await load();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not delete the file", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mt-4" data-testid="storage-files">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-sm font-medium text-primary underline"
        data-testid="storage-files-toggle"
      >
        {open ? "Hide the largest files" : "Show the largest files"}
      </button>

      {open && failed && (
        <LoadFailed testId="storage-files-error" message="The list of files could not be read." onRetry={load} />
      )}
      {open && !failed && listing === null && <p className="mt-2 text-sm text-text-muted">Loading…</p>}
      {open && !failed && listing !== null && (
        <div className="mt-2">
          {listing.files.length === 0 ? (
            <p className="text-sm text-text-muted" data-testid="storage-files-empty">
              No files are stored.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-text-muted">
                {listing.total > listing.files.length
                  ? `The ${listing.files.length} largest of ${listing.total} files.`
                  : `${listing.total} ${listing.total === 1 ? "file" : "files"}.`}{" "}
                Deleting one frees its space; a task or comment that links to it shows a broken attachment.
              </p>
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {listing.files.map((file) => (
                  <li key={file.id} className="flex items-center gap-3 px-3 py-2" data-testid="storage-file">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={file.name}>
                        {file.name}
                      </p>
                      <p className="break-words text-xs text-text-muted">
                        {[
                          file.project ? file.project.name : "no board",
                          file.uploadedBy ?? "an account that was deleted",
                          new Date(file.uploadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
                        ].join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 tabular-nums text-text-muted">{formatStorage(file.size)}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setAsking(file)}
                      aria-label={`Delete ${file.name}`}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        onConfirm={() => asking && void remove(asking)}
        title={asking ? `Delete ${asking.name}?` : "Delete file?"}
        message={
          asking
            ? `This frees ${formatStorage(asking.size)}. Anything that links to the file will show a broken attachment, and it cannot be undone.`
            : ""
        }
        loading={deleting}
      />
    </div>
  );
}
