"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { Navbar } from "@/components/Navbar";

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <Navbar />
      <main className="max-w-[1600px] mx-auto px-4 py-6">{children}</main>
    </AuthGuard>
  );
}
