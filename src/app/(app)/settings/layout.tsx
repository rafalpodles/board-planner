"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/shell/PageHeader";

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
      { id: "security", label: "Security" },
      { id: "tokens", label: "API Tokens" },
    ],
  },
  {
    title: "Administration",
    adminOnly: true,
    sections: [
      { id: "users", label: "Users" },
      { id: "agents", label: "PM Agents" },
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
  const groups = GROUPS.filter((g) => !g.adminOnly || isAdmin);
  const flat = groups.flatMap((g) => g.sections);

  return (
    <>
      <PageHeader title="Settings" subtitle="This account and this instance" />

      {/* Horizontal pill row below md, sidebar above — same shape as project settings */}
      <nav
        className="md:hidden -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1"
        aria-label="Settings sections"
      >
        {flat.map((s) => (
          <Link
            key={s.id}
            href={`/settings/${s.id}`}
            aria-current={s.id === active ? "page" : undefined}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
              s.id === active
                ? "border-primary bg-primary-solid font-semibold text-white"
                : "border-border bg-bg-card text-text-muted"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      <div className="md:grid md:grid-cols-[13rem_1fr] md:gap-8">
        <nav
          className="hidden md:block md:sticky md:top-4 md:self-start"
          aria-label="Settings sections"
        >
          {groups.map((g) => (
            <div key={g.title} className="mb-5">
              <p className="px-2.5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {g.title}
              </p>
              <div className="space-y-0.5">
                {g.sections.map((s) => (
                  <Link
                    key={s.id}
                    href={`/settings/${s.id}`}
                    aria-current={s.id === active ? "page" : undefined}
                    className={`block rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      s.id === active
                        ? "bg-primary/15 font-semibold text-text"
                        : "text-text-muted hover:bg-bg-hover hover:text-text"
                    }`}
                  >
                    {s.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
