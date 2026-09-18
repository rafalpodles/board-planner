"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { isPmRunnable } from "@/lib/pm/gate";
import { openLayerCount } from "@/lib/focus-trap";
import { OWNS_ITS_KEYS } from "@/lib/keyboard-scope";
import { projectRefFromPathname } from "@/lib/urls";
import { ApiProject } from "@/types";
import { PmChat } from "./PmChat";

export function PmChatWidget() {
  const pathname = usePathname();
  const api = useApi();

  const projectId = projectRefFromPathname(pathname);
  const onPmPage = !!pathname && /\/pm\/?$/.test(pathname);

  const [project, setProject] = useState<ApiProject | null>(null);
  const [open, setOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  // The panel takes the focus when it opens, and that is what makes the rest of this work: a click
  // on its header or on a message lands on nothing focusable, and without this the focus would sit
  // on the launcher — outside the panel — so a key pressed straight after clicking *inside* the
  // chat would be read as the board's. Measured, after shipping the version that did not do it.
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  // The panel is not a layer, so nothing else answers Escape for it. Handled where the key lands
  // rather than on `document`: a global listener would also answer for the page outside the panel,
  // which still belongs to the board (BP-654).
  const dismissOnEscape = (e: React.KeyboardEvent) => {
    // A real layer inside the panel — the attachment lightbox — answers Escape first. Closing the
    // panel under it would unmount the draft and the staged uploads with it, which is the loss
    // PmChatWidget.test.tsx already guards against for a dialog opened elsewhere.
    if (e.key !== "Escape" || openLayerCount() > 0) return;
    // Mid-composition — Japanese, Chinese, Korean — Escape cancels the IME's candidate window and
    // belongs to the field, not to the panel
    if (e.nativeEvent.isComposing) return;
    // The board's handler listens on `document`, and so does React's delegate — so this key
    // reaches the board after this handler has run, by which time `open` is false and the marker
    // that would have told the board to keep its hands off is gone from the launcher. Measured as
    // an outcome rather than reasoned about: without this line, Escape pressed on the launcher
    // closed the chat AND cleared the board's selection behind it. `stopPropagation` is not enough
    // — it does not stop another listener on the same node.
    e.nativeEvent.stopImmediatePropagation();
    closePanel();
  };

  /** Every way out of the panel, so the focus never lands on `body` by accident */
  const closePanel = () => {
    setOpen(false);
    // The focus was inside the panel that is about to leave the DOM
    launcherRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    setProject(null);
    setOpen(false);
    if (!projectId) return;
    api
      .get(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId || onPmPage || !project?.pmAvailable || !isPmRunnable(project?.pm)) {
    return null;
  }

  return (
    <>
      {/* The panel is raised with the launcher, and shortened to match: the launcher is painted
          after it at the same z, so at the lower anchor that button sits on the panel's own Send
          — a tap meant for Send closed the chat and took the typed message with it. */}
      {open && (
        <div
          data-testid="pm-chat-panel"
          ref={panelRef}
          // It takes the focus when it opens, so it announces itself rather than letting a reader
          // land on an unnamed div and hear its contents
          role="complementary"
          aria-labelledby="pm-chat-panel-title"
          // Focusable only programmatically: it is the click target of last resort inside the
          // panel, so anything clicked in here leaves the focus in here
          tabIndex={-1}
          // The keyboard inside the panel is the panel's, so the board's shortcuts do not fire
          // behind it (BP-654)
          {...{ [OWNS_ITS_KEYS]: "" }}
          onKeyDown={dismissOnEscape}
          // Says the bottom-right corner is taken, the way the bars say the bottom strip is. The
          // panel and the toast were anchored to the same `bottom-40` over a pinned bar, and the
          // toast is painted a layer above — so it landed on Send (BP-596).
          data-corner-panel
          className="fixed bottom-24 right-4 z-40 w-[min(30rem,calc(100vw-2rem))] h-[min(44rem,calc(100vh-8rem))] max-lg:[body:has([data-pinned-phone-bar])_&]:bottom-40 max-lg:[body:has([data-pinned-phone-bar])_&]:h-[min(44rem,calc(100vh-12rem))] [body:has([data-pinned-bottom-bar])_&]:bottom-40 [body:has([data-pinned-bottom-bar])_&]:h-[min(44rem,calc(100vh-12rem))] bg-bg border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <div
            // The band a toast standing on the panel has to start below: these are its controls
            // (BP-597)
            data-corner-panel-header
            className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-card shrink-0"
          >
            <p id="pm-chat-panel-title" className="font-semibold text-sm">🤖 PM — {project.name}</p>
            <div className="flex items-center gap-3">
              <Link
                href={`/projects/${projectId}/pm`}
                title="Open full page"
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text text-sm"
              >
                ⤢
              </Link>
              <button
                onClick={closePanel}
                className="text-text-muted hover:text-text cursor-pointer"
                aria-label="Close PM chat"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <PmChat projectId={projectId} preloadedProject={project} />
          </div>
        </div>
      )}
      {/* z-40, not z-50: at equal z the one painted last wins, and that is this, rendered after
          the page — so a dialog's own buttons were losing to it, and below the scrim it greys out
          with the rest of the page (BP-589). The raised position is for a bar pinned to the
          bottom, which layering cannot settle: both are meant to be pressed (BP-591).

          Two attributes, because the bars know different things about themselves.
          `data-pinned-bottom-bar` is the general one: a bar that can say when it is on screen
          sets it, and the rule applies at every width. `data-pinned-phone-bar` is for a bar that
          only CSS hides — the comment bar is `lg:hidden` and cannot say so from JSX — so its rule
          repeats that breakpoint. A new bottom bar wants the first (BP-593). */}
      <button
        ref={launcherRef}
        onClick={() => setOpen((v) => !v)}
        // Gated on `open`, not simply set or simply absent. The panel has no focus trap — it is
        // not a layer — so Tab walks out of it onto this button, which sits outside the panel:
        // while the chat is open this is still the chat's, or `n` there would open New Task over
        // it and Escape would clear the board's selection behind it. Once the chat is closed it is
        // the board's page again, and the focus lands back here (BP-654).
        {...(open ? { [OWNS_ITS_KEYS]: "" } : {})}
        onKeyDown={open ? dismissOnEscape : undefined}
        aria-label={open ? "Close PM chat" : "Open PM chat"}
        // Says it shares the corner, so a toast stands above it rather than on it (BP-597)
        data-corner-obstacle
        title="PM Agent"
        className="fixed bottom-6 right-4 z-40 max-lg:[body:has([data-pinned-phone-bar])_&]:bottom-24 [body:has([data-pinned-bottom-bar])_&]:bottom-24 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-primary-solid text-white shadow-lg ring-4 ring-primary/20 transition-colors hover:bg-primary-solid-hover"
      >
        {open ? (
          <svg
            className="h-[26px] w-[26px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg
            className="h-[26px] w-[26px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 7V4M6 7h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zM9 13h.01M15 13h.01"
            />
          </svg>
        )}
      </button>
    </>
  );
}
