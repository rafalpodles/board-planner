"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openLayerCount } from "@/lib/focus-trap";
import { useApi } from "@/hooks/use-api";
import { usePanelClamp } from "@/hooks/use-panel-clamp";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiSavedView } from "@/types";
import { projectPath } from "@/lib/urls";

export interface ViewSnapshot {
  filters: Record<string, unknown>;
  search: string;
  sortField: string;
  sortDir: "asc" | "desc";
  viewMode: "board" | "list";
  groupBy: string;
  sprintScope: string;
  hiddenColumns: string[];
}

interface ViewsMenuProps {
  projectId: string;
  projectRef: string;
  canShare: boolean;
  snapshot: () => ViewSnapshot;
  onApply: (view: ApiSavedView) => void;
}

const field =
  "focus-ring h-8 w-full rounded-lg border border-border bg-bg-input px-2 text-[12px] text-text";
const action =
  "focus-ring min-h-6 rounded px-1.5 py-1 text-[12px] text-text-muted underline hover:text-text";

export function ViewsMenu({ projectId, projectRef, canShare, snapshot, onApply }: ViewsMenuProps) {
  const api = useApi();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<ApiSavedView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [withSearch, setWithSearch] = useState(false);
  const [share, setShare] = useState(false);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<ApiSavedView | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelEl = useRef<HTMLDivElement | null>(null);
  const loadSeq = useRef(0);
  const panel = usePanelClamp(open);
  const base = `/api/projects/${projectId}/views`;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const loaded = (await api.get(base)) as ApiSavedView[];
      if (seq !== loadSeq.current) return;
      setViews(loaded);
      setFailed(false);
    } catch {
      if (seq === loadSeq.current) setFailed(true);
    }
  }, [api, base]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (open) panelEl.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    }
    // Capture phase and stopped, so the board's own Escape (which clears the selection) does not
    // also fire; a dialog opened from here keeps the key for itself
    function escape(e: KeyboardEvent) {
      if (e.key !== "Escape" || openLayerCount() > 0) return;
      e.stopPropagation();
      // A rename in progress is what Escape cancels first
      if (renaming) {
        setRenaming(null);
        return;
      }
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, renaming]);

  async function write(run: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setProblem("");
    try {
      await run();
      await load();
      if (done) toast(done, "success");
      return true;
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not save");
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const current = snapshot();
    const saved = await write(
      () =>
        api.post(base, {
          name,
          shared: canShare && share,
          ...current,
          search: withSearch ? current.search : "",
        }),
      "View saved"
    );
    if (saved) {
      setName("");
      setShare(false);
      setWithSearch(false);
    }
  }

  async function copyLink(view: ApiSavedView) {
    const link = `${window.location.origin}${projectPath(projectRef)}?view=${view._id}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied", "success");
    } catch {
      toast("Copy failed — the link is " + link, "error");
    }
  }

  const list = views ?? [];

  return (
    <div
      className="relative shrink-0"
      ref={root}
      onBlur={(e) => {
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        onClick={() => {
          setOpen((v) => !v);
          setProblem("");
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="focus-ring flex h-11 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px] font-medium text-text-muted transition-colors hover:text-text"
      >
        Views
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          ref={(el) => {
            panel.ref.current = el;
            panelEl.current = el;
          }}
          tabIndex={-1}
          style={panel.style}
          role="dialog"
          aria-label="Views"
          className="absolute right-0 top-full z-40 mt-1 w-[340px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-bg-card p-3 shadow-lg sm:left-0 sm:right-auto"
        >
          {failed && (
            <p role="alert" className="mb-2 text-[12px] text-danger">
              Views could not be loaded.{" "}
              <button type="button" onClick={() => void load()} className={action}>
                Try again
              </button>
            </p>
          )}

          {views && list.length === 0 && (
            <p className="mb-2 text-[12px] text-text-muted">
              No saved views yet. Save the filters, sort and layout you have now to come back to them.
            </p>
          )}

          <ul className="mb-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
            {list.map((view) => (
              <li key={view._id} data-testid="saved-view" className="rounded-lg border border-border p-1.5">
                {renaming?.id === view._id ? (
                  <form
                    className="flex gap-1"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await write(() => api.put(base, { viewId: view._id, name: renaming.name }), "View renamed")) setRenaming(null);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`New name for ${view.name}`}
                      maxLength={100}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: view._id, name: e.target.value })}
                      className={field}
                    />
                    <button type="submit" disabled={busy} className={action}>
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)} className={action}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onApply(view);
                        setOpen(false);
                        trigger.current?.focus();
                      }}
                      className="focus-ring min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-[13px] font-medium text-text hover:bg-bg-input"
                      title={view.name}
                    >
                      {view.name}
                    </button>
                    {view.shared && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        Shared
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 px-1">
                  {view.shared && (
                    <button type="button" onClick={() => void copyLink(view)} className={action}>
                      Copy link
                    </button>
                  )}
                  {view.canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() => setRenaming({ id: view._id, name: view.name })}
                        className={action}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void write(
                            // The search text is a view's own only if it kept one when it was saved
                            () => api.put(base, { viewId: view._id, ...snapshot(), search: view.search ? snapshot().search : "" }),
                            `Updated ${view.name}`
                          )
                        }
                        className={action}
                        title="Replace this view with what is on screen now"
                      >
                        Update to current
                      </button>
                      {canShare && view.mine && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void write(
                              () => api.put(base, { viewId: view._id, shared: !view.shared }),
                              view.shared ? `Stopped sharing ${view.name}` : `Shared ${view.name}`
                            )
                          }
                          className={action}
                        >
                          {view.shared ? "Stop sharing" : "Share"}
                        </button>
                      )}
                      <button type="button" onClick={() => setRemoving(view)} className={action}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-2 border-t border-border pt-3"
          >
            <p className="text-[11px] font-semibold text-text-muted">Save what is on screen as a view</p>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-muted">View name</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setProblem("");
                }}
                maxLength={100}
                className={field}
              />
            </label>
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[12px] text-text">
              <input
                type="checkbox"
                checked={withSearch}
                onChange={(e) => setWithSearch(e.target.checked)}
                className="focus-ring h-4 w-4"
              />
              Include the search text
            </label>
            {canShare && (
              <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[12px] text-text">
                <input
                  type="checkbox"
                  checked={share}
                  onChange={(e) => setShare(e.target.checked)}
                  className="focus-ring h-4 w-4"
                />
                Share with everyone on this board
              </label>
            )}
            {problem && (
              <p role="alert" className="text-[12px] text-danger">
                {problem}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="focus-ring h-8 rounded-lg bg-primary-solid px-3 text-[12px] font-medium text-white disabled:opacity-50"
            >
              Save view
            </button>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await write(() => api.del(base, { viewId: removing._id }), "View deleted");
          setRemoving(null);
        }}
        title="Delete view"
        message={removing ? `Delete "${removing.name}"?${removing.shared ? " Everyone on this board loses it." : ""}` : ""}
        confirmLabel="Delete"
        loading={busy}
      />
    </div>
  );
}
