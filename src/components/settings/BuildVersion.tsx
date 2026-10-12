"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

interface Build {
  version: string;
  shortSha: string;
}

export function BuildVersion() {
  const api = useApi();
  const { toast } = useToast();
  const [build, setBuild] = useState<Build | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .get("/api/version")
      .then((answer: Build) => current && setBuild(answer))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const token = build ? `${build.version} · ${build.shortSha}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the version and copy it manually", "error");
    }
  }

  return (
    <>
      <dt className="text-text-muted">Version</dt>
      <dd className="min-w-0" data-testid="build-version">
        {failed ? (
          <span className="text-danger">Could not be read.</span>
        ) : build === null ? (
          <span className="text-text-muted" aria-busy="true">
            <span className="sr-only">Loading version</span>
            <span aria-hidden="true">…</span>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs select-all" data-testid="build-version-token">
              {token}
            </code>
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </span>
        )}
      </dd>
    </>
  );
}
