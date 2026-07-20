"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { Navbar } from "@/components/Navbar";
import { PmChatWidget } from "@/components/pm/PmChatWidget";

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <Navbar />
      <main className="max-w-[1920px] mx-auto px-4 py-6">{children}</main>
      <PmChatWidget />
    </AuthGuard>
  );
}
