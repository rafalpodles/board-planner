"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiProject } from "@/types";
import { effectiveColumns } from "@/lib/columns";
import {
  SettingsProvider,
  useDirtyRegistry,
} from "@/components/settings/settings-context";
import { SaveBar } from "@/components/settings/SaveBar";
import { GeneralSection } from "./sections/GeneralSection";
import { BoardSection } from "./sections/BoardSection";
import { TaskFieldsSection } from "./sections/TaskFieldsSection";
import { IntegrationsSection } from "./sections/IntegrationsSection";
import { PmAgentSection } from "./sections/PmAgentSection";
import { WorkersSection } from "./sections/WorkersSection";
import { AuditSection } from "./sections/AuditSection";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";

type Access = "member" | "projectAdmin" | "instanceAdmin";

interface SectionMeta {
  id: string;
  label: string;
  title: string;
  blurb: string;
  keywords: string;
  access: Access;
  icon: React.ReactNode;
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const SECTIONS: SectionMeta[] = [
  {
    id: "general",
    label: "General",
    title: "General",
    blurb:
      "What this project is called, who can change its settings, and how to remove it.",
    keywords: "name key icon description owner admins access delete rename",
    access: "projectAdmin",
    icon: <Icon d="M4 6h16M4 12h16M4 18h10" />,
  },
  {
    id: "board",
    label: "Board",
    title: "Board",
    blurb:
      "Columns on the Kanban board. Automation — Claude Code, the PM agent, webhooks — follows the role you map a column to, not its name.",
    keywords:
      "columns status role backlog approved active review blocked done order",
    access: "projectAdmin",
    icon: <Icon d="M5 4v16M12 4v11M19 4v7" />,
  },
  {
    id: "fields",
    label: "Task fields",
    title: "Task fields",
    blurb:
      "The vocabulary tasks are described with: what they are, what part of the product they touch, and any extra fields you need.",
    keywords:
      "categories custom fields templates tags dropdown required",
    access: "projectAdmin",
    icon: (
      <Icon d="M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 010 2.8zM7.5 7.5h.01" />
    ),
  },
  {
    id: "integrations",
    label: "Integrations",
    title: "Integrations",
    blurb:
      "Connect the board to the places work actually happens — code hosting and team chat.",
    keywords:
      "github gitlab token webhook slack discord notifications pull request merge sync repo",
    access: "projectAdmin",
    icon: (
      <Icon d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" />
    ),
  },
  {
    id: "workers",
    label: "Workers",
    title: "Workers",
    blurb:
      "Whether autonomous workers may run this project's approved tasks, and how they should behave.",
    keywords: "worker agent autonomous merge branch diff model gates checkout repository",
    access: "instanceAdmin",
    icon: <Icon d="M4 7h16M4 12h16M4 17h7" />,
  },
  {
    id: "pm",
    label: "PM agent",
    title: "PM agent",
    blurb:
      "A chat-driven project manager that can review the board on its own and act on tasks.",
    keywords:
      "pm agent autonomy board review frequency interval schedule model context notes mcp openrouter turn cap timezone links",
    access: "projectAdmin",
    icon: (
      <Icon d="M12 7V4M6 7h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zM9 13h.01M15 13h.01" />
    ),
  },
  {
    id: "audit",
    label: "Audit log",
    title: "Audit log",
    blurb: "Every settings change on this project, newest first.",
    keywords: "audit log history changes who when activity",
    access: "projectAdmin",
    icon: <Icon d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2" />,
  },
];

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();
  const { isAdmin } = useAuth();
  const { toast } = useToast();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("");
  const [query, setQuery] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);

  const { register, unregister, pending, total } = useDirtyRegistry();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("mcp_oauth");
    if (oauthResult) {
      if (oauthResult === "ok")
        toast("MCP OAuth connection established", "success");
      else
        toast(
          `MCP OAuth failed: ${oauthResult.replace(/^error:/, "")}`,
          "error",
        );
      setSection("pm");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?section=pm`,
      );
    } else {
      const requested = params.get("section");
      if (requested) setSection(requested);
    }

    api
      .get(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => toast("Failed to load project", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const patchProject = useCallback(
    (
      patch: Partial<ApiProject> | ((prev: ApiProject) => Partial<ApiProject>),
    ) => {
      setProject((p) =>
        p ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) } : p,
      );
    },
    [],
  );

  const replaceProject = useCallback(
    (next: ApiProject) => setProject(next),
    [],
  );

  const visible = useMemo(() => {
    if (!project) return [];
    return SECTIONS.filter((s) => {
      if (s.access === "instanceAdmin") return isAdmin;
      if (s.access === "projectAdmin") return project.canAdmin;
      return true;
    });
  }, [project, isAdmin]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((s) =>
      `${s.label} ${s.keywords}`.toLowerCase().includes(q),
    );
  }, [visible, query]);

  const active = useMemo(() => {
    if (visible.some((s) => s.id === section)) return section;
    return visible[0]?.id ?? "";
  }, [visible, section]);

  const goToSection = useCallback((id: string, scroll = true) => {
    setSection(id);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?section=${id}`,
    );
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const badges = useMemo(() => {
    if (!project) return {} as Record<string, { count?: number; on?: boolean }>;
    return {
      board: { count: effectiveColumns(project.columns).length },
      fields: {
        count:
          (project.categories?.length || 0) +
          (project.customFields?.length || 0) +
          (project.taskTemplates?.length || 0),
      },
      integrations: {
        on:
          !!project.githubTokenSet ||
          !!project.gitlabTokenSet ||
          (project.notificationChannels?.length || 0) > 0 ||
          (project.webhooks?.length || 0) > 0,
      },
      pm: { on: !!project.pm?.enabled && !project.pm?.lockedByInstance },
    } as Record<string, { count?: number; on?: boolean }>;
  }, [project]);

  if (loading || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const activeMeta = visible.find((s) => s.id === active);
  const sectionProps = {
    projectId,
    project,
    patchProject,
    replaceProject,
    isAdmin,
  };

  function navButton(s: SectionMeta, mobile: boolean) {
    const badge = badges[s.id];
    if (mobile) {
      return (
        <button
          key={s.id}
          onClick={() => goToSection(s.id)}
          aria-current={s.id === active}
          className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
            s.id === active
              ? "border-primary bg-primary-solid font-semibold text-white"
              : "border-border bg-bg-card text-text-muted"
          }`}
        >
          {s.label}
        </button>
      );
    }
    return (
      <button
        key={s.id}
        onClick={() => goToSection(s.id)}
        aria-current={s.id === active}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
          s.id === active
            ? "bg-primary/15 font-semibold text-text"
            : "text-text-muted hover:bg-bg-hover hover:text-text"
        }`}
      >
        <span className={s.id === active ? "text-primary" : ""}>{s.icon}</span>
        <span className="flex-1 truncate">{s.label}</span>
        {badge?.count !== undefined && (
          <span className="rounded-full bg-bg-input px-1.5 text-[11px] text-text-muted">
            {badge.count}
          </span>
        )}
        {badge?.on !== undefined && (
          <span
            className={`h-1.5 w-1.5 rounded-full ${badge.on ? "bg-success" : "bg-text-muted/50"}`}
            title={badge.on ? "Configured" : "Not configured"}
          />
        )}
      </button>
    );
  }

  const projectSections = matches;

  return (
    <>
      <div className="pb-32">
        <PageHeader
          title="Settings"
          icon={project.icon || "📋"}
          subtitle={`${project.name} · ${project.key}`}
          actions={
            // Kept, unlike the other pages' back arrows: this one is the only
            // trigger for the unsaved-changes guard
            <button
              onClick={() =>
                total > 0
                  ? setConfirmLeave(true)
                  : router.push(`/projects/${projectId}`)
              }
              className="focus-ring rounded px-2 py-1 text-sm text-text-muted hover:text-text"
            >
              Back to board
            </button>
          }
        />

        <div className="md:grid md:grid-cols-[236px_minmax(0,1fr)] md:gap-7">
          <nav
            className="hidden md:block md:sticky md:top-4 md:self-start"
            aria-label="Settings sections"
          >
            <div className="relative mb-3">
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  const q = e.target.value.trim().toLowerCase();
                  if (!q) return;
                  const first = visible.find((s) =>
                    `${s.label} ${s.keywords}`.toLowerCase().includes(q),
                  );
                  if (first) goToSection(first.id, false);
                }}
                placeholder="Search settings..."
                aria-label="Search settings"
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {projectSections.length > 0 && (
              <div className="mb-4">
                <h2 className="mb-1.5 ml-2.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                  Project
                </h2>
                {projectSections.map((s) => navButton(s, false))}
              </div>
            )}

            {isAdmin && (
              <div className="mt-4">
                <h2 className="mb-1.5 ml-2.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                  All projects
                </h2>
                {/* Nothing instance-wide is edited here any more — the link is the
                    whole point, so a setting that affects every project cannot be
                    mistaken for one of this project's */}
                <Link
                  href="/settings/agents"
                  className="focus-ring flex min-h-[40px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13.5px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
                >
                  AI &amp; agents ↗
                </Link>
                <p className="mt-1 px-2.5 text-[11.5px] leading-snug text-text-muted">
                  Instance settings live outside this project.
                </p>
              </div>
            )}

            {matches.length === 0 && (
              <p className="px-2.5 text-sm text-text-muted">
                Nothing matches &ldquo;{query}&rdquo;.
              </p>
            )}

            {!project.canAdmin && (
              <p className="mt-4 px-2.5 text-[11.5px] leading-snug text-text-muted">
                The rest of this project&apos;s settings need admin access.
              </p>
            )}
          </nav>

          <nav
            className="sticky top-0 z-30 -mx-4 mb-4 flex gap-2 overflow-x-auto border-b border-border bg-bg/95 px-4 py-3 backdrop-blur md:hidden"
            aria-label="Settings sections"
          >
            {visible.map((s) => navButton(s, true))}
          </nav>

          <main>
            {activeMeta && (
              <header className="mb-4">
                <h2 className="text-xl font-bold tracking-tight">
                  {activeMeta.title}
                </h2>
                <p className="max-w-[62ch] text-sm text-text-muted">
                  {activeMeta.blurb}
                </p>
              </header>
            )}

            <SettingsProvider register={register} unregister={unregister}>
              {visible.map((s) => (
                <div key={s.id} className={s.id === active ? "" : "hidden"}>
                  {s.id === "general" && <GeneralSection {...sectionProps} />}
                  {s.id === "board" && (
                    <BoardSection
                      {...sectionProps}
                      active={active === "board"}
                    />
                  )}
                  {s.id === "fields" && <TaskFieldsSection {...sectionProps} />}
                  {s.id === "integrations" && (
                    <IntegrationsSection {...sectionProps} />
                  )}
                  {s.id === "workers" && <WorkersSection {...sectionProps} />}
                  {s.id === "pm" && <PmAgentSection {...sectionProps} />}
                  {s.id === "audit" && (
                    <AuditSection
                      projectId={projectId}
                      active={active === "audit"}
                    />
                  )}
                </div>
              ))}
            </SettingsProvider>
          </main>
        </div>
      </div>

      <SaveBar pending={pending} total={total} onGoToSection={goToSection} />

      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => router.push(`/projects/${projectId}`)}
        title="Leave without saving?"
        message={`You have ${total === 1 ? "1 unsaved change" : `${total} unsaved changes`}. Leaving now discards them.`}
        confirmLabel="Discard and leave"
      />
    </>
  );
}
