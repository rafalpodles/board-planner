"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LicenceSettingsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/organisation");
  }, [router]);
  return null;
}
