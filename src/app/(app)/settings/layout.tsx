"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  SettingsShell,
  type SettingsNavGroup,
} from "@/components/settings/SettingsShell";

interface SettingsGroup {
  title: string;
  adminOnly?: boolean;
  sections: { id: string; label: string }[];
}

// Each admin page guards itself; hiding the group here only keeps the nav honest
const GROUPS: SettingsGroup[] = [
  {
    title: "Account",
    sections: [
      { id: "profile", label: "Profile" },
      { id: "preferences", label: "Preferences" },
      { id: "notifications", label: "Notifications" },
      { id: "security", label: "Security" },
      { id: "tokens", label: "API Tokens" },
      { id: "machines", label: "Machines" },
    ],
  },
  {
    title: "Administration",
    adminOnly: true,
    sections: [
      { id: "users", label: "Users" },
      { id: "email", label: "Email" },
      { id: "agents", label: "PM Agents" },
      { id: "workers", label: "Workers" },
      { id: "audit", label: "Audit log" },
    ],
  },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { isAdmin } = useAuth();

  const section = pathname?.split("/")[2] ?? "";
  // A machine's project picker lives under the fleet console's path, which only an admin's nav lists
  const active = section === "workers" && !isAdmin ? "machines" : section;
  const groups: SettingsNavGroup[] = GROUPS.filter(
    (g) => !g.adminOnly || isAdmin,
  ).map((g) => ({
    title: g.title,
    items: g.sections.map((s) => ({
      id: s.id,
      label: s.label,
      href: `/settings/${s.id}`,
    })),
  }));

  return (
    <SettingsShell
      subtitle="This account and this instance"
      groups={groups}
      active={active}
    >
      {children}
    </SettingsShell>
  );
}
