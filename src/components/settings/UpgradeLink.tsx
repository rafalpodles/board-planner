"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { UPGRADE_HREF } from "@/lib/machine-limit-copy";

/** Only an admin can subscribe, so anybody else is told whom to ask instead of sent to a screen they cannot use. */
export function UpgradeLink() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <span className="text-text-muted">Ask an admin to upgrade.</span>;
  return (
    <Link href={UPGRADE_HREF} data-testid="upgrade-link" className="font-medium text-primary underline">
      Upgrade
    </Link>
  );
}
