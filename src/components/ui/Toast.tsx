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
import { openLayerCount, subscribeLayers } from "@/lib/focus-trap";

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

  // Read at render, not at raise: a dialog opened while a toast is still up moves it too
  const layered = useSyncExternalStore(
    subscribeLayers,
    () => openLayerCount() > 0,
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
          // A phone's dialog is a bottom sheet whose action row is exactly where a toast lands.
          // It moves rather than dropping a layer: behind the scrim it would be unreadable, and a
          // toast raised from inside the dialog is feedback the reader needs (BP-590).
          className={`fixed z-50 flex max-w-sm flex-col gap-2 sm:bottom-4 sm:right-4 sm:left-auto sm:top-auto sm:w-auto sm:translate-x-0 ${
            layered
              ? "left-1/2 top-4 w-[calc(100%-2rem)] -translate-x-1/2"
              : "bottom-4 right-4"
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
