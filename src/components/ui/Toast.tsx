"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { openSheetCount, subscribeLayers } from "@/lib/focus-trap";

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
 * Three things stand where a toast lands, and the answer differs for each.
 *
 * A phone's dialog is a bottom sheet whose action row is exactly there. The toast moves to the top
 * rather than dropping a layer: behind the scrim it would be unreadable, and a toast raised from
 * inside the dialog is the feedback the reader needs (BP-590).
 *
 * A pinned bar — the comment bar, a settings save bar — is the second, and the answer is the step
 * the PM launcher already takes over the same two attributes (BP-591, BP-593). 10rem rather than
 * the launcher's 6, because the launcher itself has stepped to 6rem by then.
 *
 * The open PM panel is the third, and it is why the step alone is not enough: it is anchored to
 * that same `bottom-40` and painted a layer below, so the toast came to rest on its Send button.
 * A corner with the panel in it has no room left, so the toast goes up, exactly as it does for a
 * sheet (BP-596).
 */
const OVER_A_SHEET = "left-1/2 top-4 w-[calc(100%-2rem)] -translate-x-1/2";

const IN_THE_CORNER = [
  "bottom-4 right-4",
  // The bar step is written as "a bar, and no panel": two rules of equal weight both anchoring the
  // tray leave it stretched between them rather than one winning, so the condition carries the
  // exclusion instead of an override.
  "[body:has([data-pinned-bottom-bar]):not(:has([data-corner-panel]))_&]:bottom-40",
  "max-lg:[body:has([data-pinned-phone-bar]):not(:has([data-corner-panel]))_&]:bottom-40",
  // Below `sm` the open panel is nearly the whole screen, so there is no free corner to fall back
  // to: the toast goes under the panel's own header, over its transcript, which is the one band
  // with no control in it. Above `sm` the panel is short and bottom-anchored, so suppressing the
  // step above is enough — the corner is below it and clear.
  "max-sm:[body:has([data-corner-panel])_&]:bottom-auto",
  "max-sm:[body:has([data-corner-panel])_&]:top-20",
  "max-sm:[body:has([data-corner-panel])_&]:left-1/2",
  "max-sm:[body:has([data-corner-panel])_&]:w-[calc(100%-2rem)]",
  "max-sm:[body:has([data-corner-panel])_&]:-translate-x-1/2",
].join(" ");

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
          className={`fixed z-50 flex max-w-sm flex-col gap-2 sm:bottom-4 sm:right-4 sm:left-auto sm:top-auto sm:w-auto sm:translate-x-0 ${
            overASheet ? OVER_A_SHEET : IN_THE_CORNER
          }`}
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
