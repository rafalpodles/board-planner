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
import { placeToast, type Placement, type Surroundings } from "@/lib/toast-placement";

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

function measure(overASheet: boolean): Surroundings {
  return {
    viewportHeight: document.documentElement.clientHeight,
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
  // Measured after the paint that put the tray on screen, and again whenever what shares the
  // corner changes: a sheet opening, the panel opening, the window resizing
  useLayoutEffect(() => {
    if (toasts.length === 0) return;
    const remeasure = () => setPlacement(placeToast(measure(overASheet)));
    remeasure();
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
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
          data-testid="toast-tray"
          style={
            placement.anchor === "top"
              ? { top: placement.offset, bottom: "auto" }
              : { bottom: placement.offset }
          }
          // The horizontal half stays in CSS, because it does not depend on anything measured: a
          // phone gets the full width less a margin, a wider screen the right-hand corner.
          className={`fixed right-4 z-50 flex max-w-sm flex-col gap-2 max-sm:left-4 max-sm:right-4 max-sm:max-w-none`}
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
