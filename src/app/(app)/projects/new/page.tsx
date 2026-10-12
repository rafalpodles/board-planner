"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { ProjectWizard } from "@/components/project-wizard/ProjectWizard";

export default function NewProjectPage() {
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) router.replace("/projects");
  }, [isAdmin, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin) return null;

  return <ProjectWizard />;
}
