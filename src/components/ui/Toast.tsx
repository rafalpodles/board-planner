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
 * Three surfaces stand where a toast lands, and each wants a different answer: a bottom sheet's
 * action row, a pinned bar, and the open PM panel — which is anchored to the same place the step
 * over a bar goes. The reasoning is in BP-590, BP-591/593 and BP-596; what is here is the shape.
 */
const OVER_A_SHEET = "left-1/2 top-4 w-[calc(100%-2rem)] -translate-x-1/2";

const IN_THE_CORNER = [
  "bottom-4 right-4",
  // The bar step is written as "a bar, and no panel": two rules of equal weight both anchoring the
  // tray leave it stretched between them rather than one winning, so the condition carries the
  // exclusion instead of an override.
  "[body:has([data-pinned-bottom-bar]):not(:has([data-corner-panel]))_&]:bottom-40",
  "max-lg:[body:has([data-pinned-phone-bar]):not(:has([data-corner-panel]))_&]:bottom-40",
  // Switching the step off is not by itself a place to stand: what the corner holds is the *bar's*
  // own button, so falling back to it is the collision this exists to remove. The toast goes to
  // the middle of the screen instead, at every width — and stays there rather than returning to
  // the corner above `sm`, because `top-20` is a constant while the panel's top is not: on a
  // viewport tall enough for `h-[min(44rem,100vh-8rem)]` to stop clamping, the panel slides down
  // and its own ⤢ and ✕ arrive in that band. Centred, the tray is left of them whatever the
  // height.
  "[body:has([data-corner-panel])_&]:bottom-auto",
  "[body:has([data-corner-panel])_&]:top-20",
  "[body:has([data-corner-panel])_&]:left-1/2",
  "[body:has([data-corner-panel])_&]:w-[calc(100%-2rem)]",
  "[body:has([data-corner-panel])_&]:-translate-x-1/2",
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
