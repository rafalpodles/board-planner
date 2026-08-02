"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiProject, DEFAULT_PROJECT_ICON } from "@/types";
import { projectPath } from "@/lib/urls";
import { activityStatus } from "@/lib/activity-status";
import { isNavItemActive } from "@/lib/nav-active";

const SUB_ICONS = {
  board: "M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2",
  sprints: "M13 10V3L4 14h7v7l9-11h-7z",
  dashboard:
    "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  pm: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  importExport: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
  settings:
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
  chevron: "M9 5l7 7-7 7",
  plus: "M12 4v16m8-8H4",
} as const;

function SubIcon({ d }: { d: string }) {
  return (
    <svg
      className="h-[15px] w-[15px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

interface SubItemProps {
  href?: string;
  onClick?: () => void;
  icon: string;
  label: string;
  active?: boolean;
  dot?: boolean;
  pill?: number;
}

function SubItem({ href, onClick, icon, label, active, dot, pill }: SubItemProps) {
  const className = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
    active
      ? "bg-bg-hover font-semibold text-text"
      : "text-text-muted hover:bg-bg-hover hover:text-text"
  }`;
  const body = (
    <>
      <span className={active ? "text-primary" : undefined}>
        <SubIcon d={icon} />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />}
      {pill !== undefined && (
        <span className="shrink-0 rounded-full bg-bg-input px-1.5 text-[10px] text-text-muted">
          {pill}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-current={active ? "page" : undefined} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

interface ProjectTreeProps {
  projects: ApiProject[];
  pathname: string;
  isAdmin: boolean;
  now: number;
  onOpenImport: () => void;
  onOpenExport: () => void;
}

export function ProjectTree({
  projects,
  pathname,
  isAdmin,
  now,
  onOpenImport,
  onOpenExport,
}: ProjectTreeProps) {
  const routeProject = projects.find((p) =>
    isNavItemActive(pathname, projectPath(p.key)) || isNavItemActive(pathname, projectPath(p._id))
  );
  const [manuallyExpanded, setManuallyExpanded] = useState<string | null>(null);
  const expandedId = manuallyExpanded ?? routeProject?._id ?? null;

  return (
    <div>
      <div className="mb-1.5 ml-2.5 flex items-center gap-1">
        <Link
          href="/projects"
          className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted transition-colors hover:text-text"
        >
          Projects
        </Link>
        {isAdmin && (
          <Link
            href="/projects/new"
            title="New project"
            aria-label="New project"
            className="ml-auto mr-2.5 rounded-md p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
          >
            <SubIcon d={SUB_ICONS.plus} />
          </Link>
        )}
      </div>

      {projects.map((project) => {
        const expanded = expandedId === project._id;
        const isRouteProject = routeProject?._id === project._id;
        const base = projectPath(project.key);
        const status = activityStatus(project.lastTaskUpdate, now);

        return (
          <div key={project._id}>
            <div
              data-active-project={isRouteProject || undefined}
              className={`flex w-full items-center gap-1.5 rounded-lg pr-2.5 transition-colors hover:bg-bg-hover ${
                isRouteProject ? "shadow-[inset_3px_0_0_var(--color-primary)]" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setManuallyExpanded(expanded ? "" : project._id)}
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                className="p-1.5 text-text-muted opacity-60"
              >
                <svg
                  className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={SUB_ICONS.chevron} />
                </svg>
              </button>
              <Link
                href={base}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 text-sm text-text-muted transition-colors hover:text-text"
              >
                <span aria-hidden className="text-[15px] leading-none">
                  {project.icon || DEFAULT_PROJECT_ICON}
                </span>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-text-muted">
                  {project.key}
                </span>
              </Link>
            </div>

            {expanded && (
              <div className="ml-5 flex flex-col gap-px border-l border-border pl-3">
                {status && (
                  <p className="flex items-center gap-2 px-2 py-1 text-[11px] text-text-muted">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        status === "working" ? "bg-success" : "bg-text-muted"
                      }`}
                    />
                    {status === "working" ? "Claude working" : "Claude idle"}
                  </p>
                )}

                <SubItem
                  href={base}
                  icon={SUB_ICONS.board}
                  label="Board"
                  active={pathname === base || pathname === `${base}/`}
                  pill={project.taskCount}
                />
                <SubItem
                  href={`${base}/sprints`}
                  icon={SUB_ICONS.sprints}
                  label="Sprints"
                  active={isNavItemActive(pathname, `${base}/sprints`)}
                  dot={project.hasActiveSprint}
                />
                <SubItem
                  href={`${base}/dashboard`}
                  icon={SUB_ICONS.dashboard}
                  label="Dashboard"
                  active={isNavItemActive(pathname, `${base}/dashboard`)}
                />
                {!project.pm?.lockedByInstance && (
                  <SubItem
                    href={`${base}/pm`}
                    icon={SUB_ICONS.pm}
                    label="PM agent"
                    active={isNavItemActive(pathname, `${base}/pm`)}
                    dot={project.pm?.enabled}
                  />
                )}
                {isRouteProject && (
                  <>
                    <SubItem
                      onClick={onOpenImport}
                      icon={SUB_ICONS.importExport}
                      label="Import"
                    />
                    <SubItem
                      onClick={onOpenExport}
                      icon={SUB_ICONS.importExport}
                      label="Export"
                    />
                  </>
                )}
                {isAdmin && (
                  <SubItem
                    href={`${base}/settings`}
                    icon={SUB_ICONS.settings}
                    label="Settings"
                    active={isNavItemActive(pathname, `${base}/settings`)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
