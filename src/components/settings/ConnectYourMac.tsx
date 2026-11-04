"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { EXECUTION_DOCS_URL, LATEST_RELEASE_URL } from "@/lib/docs-urls";

export const BREW_INSTALL = [
  "brew tap rafalpodles/tap",
  "brew trust --cask rafalpodles/tap/board-planner-worker",
  "brew install --cask rafalpodles/tap/board-planner-worker",
].join("\n");

export function ConnectYourMac() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(BREW_INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the commands and copy them manually", "error");
    }
  }

  return (
    <section
      aria-labelledby="connect-your-mac"
      data-testid="connect-your-mac"
      className="mb-6 rounded-lg border border-border bg-bg-card p-4 text-sm"
    >
      <h3 id="connect-your-mac" className="mb-3 font-semibold">
        Connect your Mac
      </h3>
      <ol className="list-decimal space-y-3 pl-5 text-text-muted">
        <li>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p>Install the Board Planner Worker app with Homebrew:</p>
            <Button size="sm" variant="secondary" onClick={copy} className="shrink-0 whitespace-nowrap">
              {copied ? "Copied!" : "Copy commands"}
            </Button>
          </div>
          <pre
            data-testid="brew-install"
            className="overflow-x-auto rounded border border-border bg-bg px-2.5 py-2 text-[11px] leading-5 text-text select-all"
          >
            {BREW_INSTALL}
          </pre>
          <p className="mt-2 text-xs">
            No Homebrew?{" "}
            <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="text-primary underline">
              Download the app
            </a>{" "}
            and move it to Applications.
          </p>
        </li>
        <li>
          Open it from Applications. It lives in the menu bar: give it your Board Planner address and a folder
          for its checkouts, then click <span className="font-medium text-text">Connect</span>.
        </li>
        <li>Approve the machine on the page it opens in your browser. It then shows up below.</li>
      </ol>
      <p className="mt-3 text-xs text-text-muted">
        The app checks what the machine needs and says what is missing.{" "}
        <a href={`${EXECUTION_DOCS_URL}#setting-one-up`} target="_blank" rel="noreferrer" className="text-primary underline">
          Full guide
        </a>
      </p>
    </section>
  );
}
