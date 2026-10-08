"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useOrganisation } from "@/hooks/use-organisation";
import { ORGANISATION_NAME_MAX } from "@/lib/organisation-name";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useToast } from "@/components/ui/Toast";
import { LicenceDetails, type LicenceSummary } from "@/components/settings/LicenceDetails";
import { Subscription } from "@/components/settings/Subscription";

export default function OrganisationSettingsPage() {
  const api = useApi();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const { organisation, failed, reload, rename } = useOrganisation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [licence, setLicence] = useState<LicenceSummary | null>(null);
  const [licenceFailed, setLicenceFailed] = useState(false);

  // The name, not the summary: the summary is read again while a payment is followed, and an unsaved edit stays
  const organisationName = organisation?.name;
  useEffect(() => {
    if (organisationName !== undefined) setName(organisationName);
  }, [organisationName]);

  const loadLicence = useCallback(async () => {
    setLicenceFailed(false);
    try {
      setLicence(await api.get("/api/admin/licence"));
    } catch {
      setLicenceFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read again when the plan changes under the page, as it does when a payment is followed
  const planKey = `${organisation?.plan}|${organisation?.planEndsAt}`;
  useEffect(() => {
    if (!authLoading && isAdmin) void loadLicence();
  }, [authLoading, isAdmin, loadLicence, planKey]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await rename(name.trim());
      toast("Organisation renamed", "success");
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "Could not rename the organisation", "error");
    } finally {
      setSaving(false);
    }
  }

  if (failed) {
    return (
      <LoadFailed
        testId="organisation-settings-error"
        message="Failed to read the organisation, so this page cannot show it."
        onRetry={reload}
      />
    );
  }
  if (authLoading || !organisation) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const unchanged = name.trim() === organisation.name || !name.trim();

  return (
    <div className="max-w-2xl space-y-8" data-testid="organisation-page">
      <section>
        <h2 className="text-lg font-semibold mb-4">Organisation</h2>
        {isAdmin ? (
          <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input
                label="Name"
                value={name}
                maxLength={ORGANISATION_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                data-testid="organisation-name-input"
              />
            </div>
            <Button type="submit" disabled={unchanged || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </form>
        ) : (
          <div>
            <p className="text-sm font-medium text-text-muted mb-1">Name</p>
            <p className="text-sm break-words" data-testid="organisation-name">{organisation.name}</p>
          </div>
        )}
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {organisation.address && (
            <>
              <dt className="text-text-muted">Address</dt>
              <dd className="min-w-0 break-all" data-testid="organisation-address">{organisation.address}</dd>
            </>
          )}
          <dt className="text-text-muted">Plan</dt>
          <dd data-testid="organisation-plan">{organisation.plan === "pro" ? "Pro" : "Free"}</dd>
          {organisation.members !== undefined && (
            <>
              <dt className="text-text-muted">People</dt>
              <dd className="tabular-nums" data-testid="organisation-members">{organisation.members}</dd>
              <dt className="text-text-muted">Boards</dt>
              <dd className="tabular-nums" data-testid="organisation-projects">{organisation.projects}</dd>
            </>
          )}
        </dl>
      </section>

      {isAdmin && (
        <section data-testid="licence-page">
          <h2 className="text-lg font-semibold mb-1">Licence</h2>
          {!organisation.cloud && (
            <p className="text-sm text-text-muted mb-6">
              Read from <code>LICENCE_KEY</code> in the environment. To change it, set the variable and restart.
            </p>
          )}
          {organisation.cloud && <Subscription />}
          {licenceFailed ? (
            <LoadFailed
              testId="licence-settings-error"
              message="Failed to read the licence, so this page cannot say which plan this organisation is on."
              onRetry={loadLicence}
            />
          ) : licence === null ? (
            <div className="h-8" />
          ) : (
            <LicenceDetails licence={licence} />
          )}
        </section>
      )}

      {isAdmin && (
        <section>
          <h2 className="text-lg font-semibold mb-1">Export</h2>
          <p className="text-sm text-text-muted">
            Everything this organisation holds, in one file: <Link href="/settings/export" className="text-primary underline">Settings → Export</Link>.
          </p>
        </section>
      )}
    </div>
  );
}
