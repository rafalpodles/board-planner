"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { openSheetCount, subscribeLayers } from "@/lib/focus-trap";
import {
  placeToast,
  SHEET_BREAKPOINT,
  type Placement,
  type Surroundings,
} from "@/lib/toast-placement";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

/**
 * Where the tray stands is measured, not written: the corner is shared with a pinned bar, the PM
 * launcher and the PM panel, and where each of those is depends on the viewport. Four constants
 * were tried first and each failed a different one (BP-590, BP-596, BP-597). The arithmetic is in
 * `toast-placement.ts`; this reads the rectangles and applies the answer.
 */
const OBSTACLES = "[data-corner-obstacle],[data-pinned-bottom-bar],[data-pinned-phone-bar]";
/**
 * Everything `measure` reads, in one selector so the observer cannot drift from the watch. The
 * panel's header is in it because `measure` takes `headerBottom` from it, and a selector that
 * claimed to be complete while missing one would be the drift it exists to prevent.
 */
const CORNER = `${OBSTACLES},[data-corner-panel],[data-corner-panel-header]`;

function measure(overASheet: boolean, trayHeight: number): Surroundings {
  const panel = document.querySelector<HTMLElement>("[data-corner-panel]");
  const header = panel?.querySelector<HTMLElement>("[data-corner-panel-header]");
  return {
    viewportHeight: document.documentElement.clientHeight,
    trayHeight,
    // `matchMedia`, not `clientWidth`: the breakpoint mirrors a Tailwind one, and a media query
    // counts the scrollbar while `clientWidth` does not — a 15px band on Windows and Linux where
    // the dialog renders centred while the tray thought it was a sheet
    // Guarded like `Combobox`: `ToastProvider` is mounted app-wide through `AuthProvider`, so a
    // component suite on a DOM that lacks this throws inside a layout effect instead of degrading.
    // Absent, assume the wide branch — the sheet rule is the narrow exception.
    viewportWidth:
      typeof window.matchMedia === "undefined" ||
      window.matchMedia(`(min-width: ${SHEET_BREAKPOINT}px)`).matches
        ? SHEET_BREAKPOINT
        : SHEET_BREAKPOINT - 1,
    panel:
      panel && header
        ? {
            box: panel.getBoundingClientRect(),
            headerBottom: header.getBoundingClientRect().bottom,
          }
        : undefined,
    obstacles: Array.from(document.querySelectorAll<HTMLElement>(OBSTACLES))
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.height > 0),
    overASheet,
  };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, message, type }]);
      const timer = setTimeout(() => removeToast(id), 3000);
      timersRef.current.set(id, timer);
    },
    [removeToast]
  );

  // Read at render, not at raise: a sheet opened while a toast is still up moves it too
  const overASheet = useSyncExternalStore(
    subscribeLayers,
    () => openSheetCount() > 0,
    () => false
  );

  const [placement, setPlacement] = useState<Placement>({ anchor: "bottom", offset: 16 });
  const trayRef = useRef<HTMLDivElement>(null);
  /**
   * Measured after the paint that put the tray on screen, and again whenever what shares the
   * corner moves — which a `resize` listener alone does not cover, as `Combobox` already records
   * for the same attributes: the PM panel opens without one, and a pinned bar arrives over 200ms
   * of `max-height`, so the floor measured on the raise is not the one the reader ends up with.
   */
  useLayoutEffect(() => {
    if (toasts.length === 0) return;
    // The tray is in the DOM by the time a layout effect runs, so this is the real height on the
    // first pass too. The constant survives only as the value for the pass where it is not: one
    // line of text with its padding, which is what the placement assumed for every tray before.
    const trayHeight = () => trayRef.current?.getBoundingClientRect().height || 44;
    const measureNow = () =>
      setPlacement((was) => {
        const now = placeToast(measure(overASheet, trayHeight()));
        // Same numbers, same object: a new one every time would re-render the tray, whose own
        // style change is a mutation this observer would see again
        return was.anchor === now.anchor && was.offset === now.offset ? was : now;
      });

    // Coalesced: `measure` forces a synchronous layout, and the things that ask for it arrive
    // together — a MutationObserver delivers a batch of records as one callback, a resize and a
    // scroll land in the same tick, several observers fire in sequence. One layout, however many
    // asked (BP-622).
    //
    // A microtask rather than `requestAnimationFrame`, though a placement is a paint concern and
    // the frame is the tempting primitive: a frame is not guaranteed to arrive. It does not in a
    // hidden tab, and it does not under a frozen clock — `toast-finds-its-place.spec.ts` freezes
    // time so the toast's own three seconds cannot expire while the panel is opened over it, and
    // with the work deferred to a frame the tray never moved off the composer at all. Deferring
    // correctness to something that may never run is the wrong trade for a burst that is, in
    // practice, one tick wide.
    let queued = false;
    let gone = false;
    const remeasure = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!gone) measureNow();
      });
    };
    measureNow();

    // Each guarded on its own, the way `Combobox` guards them (`Combobox.tsx:214,222`): losing
    // one must not cost the other. `ToastProvider` is mounted app-wide through `AuthProvider`, so
    // a component suite on a DOM without either would otherwise throw inside a layout effect —
    // and coupling them would take the panel-arrival path away from a DOM that has
    // `MutationObserver` and not `ResizeObserver`, which is correctness rather than economy.
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    // Re-run on every arrival, not once: `SaveBar` is always mounted and turns its attribute on in
    // the same commit that starts a 200ms `max-height`, so at the moment it announces itself it is
    // still zero tall and `measure` discards it. Observing it then is what catches the growth —
    // `Combobox` re-runs its own watch for exactly this reason. `observe` on an element already
    // observed is a no-op, and its initial callback is absorbed by the bail-out above.
    const watch = () => {
      document.querySelectorAll<HTMLElement>(CORNER).forEach((el) => sizes?.observe(el));
    };
    watch();

    // The panel and the bars come and go, so their arrival is a mutation rather than a resize.
    //
    // `attributeFilter` narrows only the attribute records; `childList` with `subtree` fires on
    // every node inserted or removed anywhere in the app, and the tray-containment guard below
    // suppressed almost none of them. A toast lives three seconds — long enough for the board's
    // ten-second poll to re-render its cards, or for a dnd-kit drag to rewrite the DOM on every
    // pointer move — and each record ran two whole-document `querySelectorAll` and then forced a
    // synchronous layout. So an added or removed node has to be one of the things the placement
    // actually reads before any of that happens (BP-622).
    const movesTheTray = (node: Node) =>
      node instanceof Element && (node.matches(CORNER) || node.querySelector(CORNER) !== null);

    const arrivals =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            const relevant = records.some((record) => {
              if (trayRef.current?.contains(record.target as Node)) return false;
              if (record.type === "attributes") return true;
              return (
                Array.from(record.addedNodes).some(movesTheTray) ||
                Array.from(record.removedNodes).some(movesTheTray)
              );
            });
            if (!relevant) return;
            watch();
            remeasure();
          });
    arrivals?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-corner-panel", "data-pinned-bottom-bar", "data-pinned-phone-bar"],
    });

    window.addEventListener("resize", remeasure);
    // Both obstacles are `sticky`, not `fixed` — `SaveBar` and `MobileCommentBar` are both
    // `sticky bottom-0` — so their place in the viewport changes when their scrollport reaches the
    // point where they un-stick. That is no resize and no mutation, so nothing else here notices,
    // and the offset computed when the toast was raised is simply wrong from then on: scroll a
    // settings column to its end while a failure toast is up and the toast stays where the Save
    // bar used to be (BP-625). Capture, because the scroll happens in a container rather than on
    // the window; passive, because nothing is cancelled; and armed only while a toast is up, which
    // the effect's own bail-out already guarantees.
    document.addEventListener("scroll", remeasure, { capture: true, passive: true });
    return () => {
      sizes?.disconnect();
      arrivals?.disconnect();
      window.removeEventListener("resize", remeasure);
      document.removeEventListener("scroll", remeasure, { capture: true });
      gone = true;
    };
  }, [toasts.length, overASheet]);

  // Cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div
          ref={trayRef}
          data-testid="toast-tray"
          style={
            placement.anchor === "top"
              ? { top: placement.offset, bottom: "auto" }
              : { bottom: placement.offset }
          }
          // The horizontal half stays in CSS, because it does not depend on anything measured: a
          // phone gets the full width less a margin, a wider screen the right-hand corner.
          className="fixed right-4 z-50 flex max-w-sm flex-col gap-2 max-sm:left-4 max-sm:max-w-none"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              data-testid="toast"
              className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium
                animate-slide-in cursor-pointer
                ${
                  t.type === "success"
                    ? "bg-success-solid text-white"
                    : t.type === "error"
                      ? "bg-danger-solid text-white"
                      : "bg-bg-card text-text border border-border"
                }`}
              onClick={() => removeToast(t.id)}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
