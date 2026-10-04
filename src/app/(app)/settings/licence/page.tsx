"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { LicenceDetails, type LicenceSummary } from "@/components/settings/LicenceDetails";

export default function LicenceSettingsPage() {
  const api = useApi();
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();

  const [licence, setLicence] = useState<LicenceSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [organisation, setOrganisation] = useState("");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [summary, entitlements] = await Promise.all([
        api.get("/api/admin/licence"),
        api.get("/api/entitlements").catch(() => null),
      ]);
      setLicence(summary);
      setOrganisation(entitlements?.organisation ?? "");
    } catch {
      setFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }
    load();
  }, [isAdmin, authLoading, router, load]);

  if (authLoading || (licence === null && !failed)) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAdmin) return null;

  return (
    <div className="max-w-2xl" data-testid="licence-page">
      {organisation && (
        <p className="text-sm text-text-muted mb-4" data-testid="organisation-name">
          Organisation: <strong className="text-text">{organisation}</strong>
        </p>
      )}
      <h2 className="text-lg font-semibold mb-1">Licence</h2>
      <p className="text-sm text-text-muted mb-6">
        Read from <code>LICENCE_KEY</code> in the environment. To change it, set the variable and restart.
      </p>
      {failed || licence === null ? (
        <LoadFailed
          testId="licence-settings-error"
          message="Failed to read the licence, so this page cannot say which plan this instance is on."
          onRetry={load}
        />
      ) : (
        <LicenceDetails licence={licence} />
      )}
    </div>
  );
}
