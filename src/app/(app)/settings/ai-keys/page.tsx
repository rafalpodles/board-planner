"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { AiKeys } from "@/components/settings/AiKeys";

export default function AiKeysSettingsPage() {
  const router = useRouter();
  const { isAdmin, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAdmin) router.replace("/projects");
  }, [isAdmin, isLoading, router]);

  if (isLoading || !isAdmin) return null;

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">AI keys</h2>
      <AiKeys />
    </div>
  );
}
