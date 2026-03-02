"use client";

import { useState, FormEvent } from "react";
import { useApi } from "@/hooks/use-api";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onImported: () => void;
}

export function ImportDialog({
  open,
  onClose,
  projectId,
  onImported,
}: ImportDialogProps) {
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const api = useApi();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setResult("");
    setLoading(true);

    try {
      const data = await api.post(
        `/api/projects/${projectId}/tasks/import`,
        { markdown }
      );
      setResult(`Imported ${data.length} task(s)`);
      setMarkdown("");
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  function handleFileUpload(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      setMarkdown(e.target?.result as string);
    };
    reader.readAsText(file);
  }

  return (
    <Modal open={open} onClose={onClose} title="Import Tasks from Markdown">
      <form onSubmit={handleSubmit} className="space-y-4">
        <details className="rounded-lg border border-border bg-bg-hover/50 text-sm">
          <summary className="cursor-pointer px-4 py-2 font-medium text-text-muted hover:text-text select-none">
            Format instructions & example
          </summary>
          <div className="px-4 pb-3 pt-1 space-y-2 text-text-muted">
            <p>
              Each task uses <strong>YAML frontmatter</strong> + optional
              markdown body. Separate multiple tasks with{" "}
              <code className="bg-bg-card px-1 rounded">===</code>.
            </p>
            <div className="text-xs space-y-1">
              <p>
                <strong>Required:</strong>{" "}
                <code className="bg-bg-card px-1 rounded">title</code>,{" "}
                <code className="bg-bg-card px-1 rounded">category</code>{" "}
                (bug | doc | user-story | idea)
              </p>
              <p>
                <strong>Optional:</strong>{" "}
                <code className="bg-bg-card px-1 rounded">difficulty</code>{" "}
                (S | M | L | XL),{" "}
                <code className="bg-bg-card px-1 rounded">status</code>,{" "}
                <code className="bg-bg-card px-1 rounded">assignee</code>,{" "}
                <code className="bg-bg-card px-1 rounded">component</code>
              </p>
            </div>
            <pre className="bg-bg-card rounded-lg p-3 overflow-x-auto text-xs leading-relaxed whitespace-pre">{`---
title: Add dark mode support
category: user-story
difficulty: M
assignee: rpo
component: ui
---

## Description

Implement theme switching with system
preference detection.

## Acceptance Criteria

- Toggle in settings switches theme
- System preference is respected

===

---
title: Fix login redirect loop
category: bug
difficulty: S
---

## Description

After session expires, login redirects
back to login page in a loop.`}</pre>
          </div>
        </details>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-2">
            Upload .md file
          </label>
          <input
            type="file"
            accept=".md,.markdown,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
            }}
            className="block w-full text-sm text-text-muted file:mr-4 file:py-2 file:px-4
              file:rounded-lg file:border-0 file:text-sm file:font-medium
              file:bg-primary file:text-white hover:file:bg-primary-hover
              file:min-h-[44px] file:cursor-pointer"
          />
        </div>

        <Textarea
          label="Or paste markdown"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          rows={10}
          placeholder="---\ntitle: My Task\ncategory: user-story\n---\n\n## Description\n\n..."
        />

        {error && <p className="text-sm text-danger">{error}</p>}
        {result && <p className="text-sm text-success">{result}</p>}

        <div className="flex gap-3">
          <Button type="submit" disabled={loading || !markdown.trim()}>
            {loading ? "Importing..." : "Import"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
