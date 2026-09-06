"use client";

import { useState, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";

export default function PreferencesPage() {
  const api = useApi();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();

  const [collapseEmptyColumns, setCollapseEmptyColumns] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    api
      .get("/api/auth/me")
      .then((data: { collapseEmptyColumns?: boolean }) => {
        setCollapseEmptyColumns(data.collapseEmptyColumns ?? true);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggle(next: boolean) {
    const previous = collapseEmptyColumns;
    setCollapseEmptyColumns(next);
    try {
      await api.put("/api/users/me", { collapseEmptyColumns: next });
      await refreshUser();
      toast("Preference saved", "success");
    } catch {
      setCollapseEmptyColumns(previous);
      toast("Failed to save preference", "error");
    }
  }

  if (!loaded) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <h2 className="text-lg font-semibold mb-6">Preferences</h2>

      <div className="space-y-4">
        <div className="flex min-h-11 items-center gap-3 sm:min-h-0">
          <input
            type="checkbox"
            id="collapseEmptyColumns"
            checked={collapseEmptyColumns}
            onChange={(e) => handleToggle(e.target.checked)}
            className="focus-ring h-5 w-5 shrink-0 rounded border-border sm:h-auto sm:w-auto"
          />
          <label htmlFor="collapseEmptyColumns" className="flex min-h-11 flex-1 cursor-pointer items-center text-sm sm:inline sm:min-h-0 sm:flex-none">
            Collapse empty columns
          </label>
        </div>

        <p className="text-xs text-text-muted">
          When enabled, a board column with no tasks shrinks to a narrow rail so the
          columns that hold work get the width. Click a rail to open it for the rest
          of the session. Turn this off to keep every column at full width.
        </p>
      </div>
    </div>
  );
}
