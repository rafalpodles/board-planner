"use client";

import { ReactNode } from "react";
import { AuthContext, useAuthProvider } from "@/hooks/use-auth";
import { ToastProvider } from "@/components/ui/Toast";

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuthProvider();
  return (
    <AuthContext.Provider value={auth}>
      <ToastProvider>{children}</ToastProvider>
    </AuthContext.Provider>
  );
}
