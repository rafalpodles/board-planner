"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { SingleSignOn } from "@/components/settings/SingleSignOn";
import { SignInProviders } from "@/components/settings/SignInProviders";

export default function SingleSignOnSettingsPage() {
  const router = useRouter();
  const { isAdmin, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAdmin) router.replace("/projects");
  }, [isAdmin, isLoading, router]);

  if (isLoading || !isAdmin) return null;

  return (
    <>
      <SingleSignOn />
      <SignInProviders />
    </>
  );
}
