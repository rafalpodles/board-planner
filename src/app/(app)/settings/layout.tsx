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

const GROUPS: SettingsGroup[] = [
  {
    title: "Account",
    sections: [
      { id: "profile", label: "Profile" },
      { id: "preferences", label: "Preferences" },
      { id: "notifications", label: "Notifications" },
      { id: "security", label: "Security" },
      { id: "tokens", label: "API Tokens" },
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

  const active = pathname?.split("/")[2] ?? "";
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
