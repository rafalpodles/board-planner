"use client";

import { useState, useEffect } from "react";
import { useApi } from "@/hooks/use-api";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

export function ExportDialog({
  open,
  onClose,
  projectId,
}: ExportDialogProps) {
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const api = useApi();

  useEffect(() => {
    if (open) {
      setLoading(true);
      setCopied(false);
      api
        .post(`/api/projects/${projectId}/tasks/export`, {})
        .then((data) => setMarkdown(data.markdown))
        .catch(console.error)
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  async function handleCopy() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tasks.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal open={open} onClose={onClose} title="Export Tasks to Markdown">
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-4">
          <Textarea
            value={markdown}
            readOnly
            rows={15}
            className="font-mono text-xs"
          />

          <div className="flex gap-3">
            <Button onClick={handleCopy}>
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
            <Button variant="secondary" onClick={handleDownload}>
              Download .md
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
