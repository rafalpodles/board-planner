"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiProject, DEFAULT_PROJECT_ICON } from "@/types";
import { projectPath } from "@/lib/urls";
import { isNavItemActive } from "@/lib/nav-active";
import { reorderedIds } from "@/lib/reorder";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const SUB_ICONS = {
  board: "M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2",
  sprints: "M13 10V3L4 14h7v7l9-11h-7z",
  dashboard:
    "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  pm: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
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
  href: string;
  icon: string;
  label: string;
  active?: boolean;
  dot?: boolean;
  pill?: number;
}

function SubItem({ href, icon, label, active, dot, pill }: SubItemProps) {
  const className = `focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors md:min-h-0 ${
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

  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={className}>
      {body}
    </Link>
  );
}

/**
 * Carries useSortable for one project. The whole row is the handle here, so the
 * listeners go on the row while the sortable element is the wrapper that also holds
 * the expanded sub-items — otherwise the sub-items would not travel with it.
 */
function SortableProject({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (state: {
    setNodeRef: (el: HTMLElement | null) => void;
    handleProps: Record<string, unknown>;
    style: React.CSSProperties;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id, disabled });

  return children({
    setNodeRef,
    handleProps: { ...attributes, ...listeners },
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
      ...(isDragging ? { position: "relative", zIndex: 20 } : {}),
    },
    isDragging,
  });
}

interface ProjectTreeProps {
  projects: ApiProject[];
  pathname: string;
  isAdmin: boolean;
  /** Omitted for anyone who may not change the shared order */
  onReorder?: (orderedIds: string[]) => void;
}

export function ProjectTree({
  projects,
  pathname,
  isAdmin,
  onReorder,
}: ProjectTreeProps) {
  const routeProject = projects.find((p) =>
    isNavItemActive(pathname, projectPath(p.key)) || isNavItemActive(pathname, projectPath(p._id))
  );
  const [manuallyExpanded, setManuallyExpanded] = useState<string | null>(null);
  const expandedId = manuallyExpanded ?? routeProject?._id ?? null;

  const canReorder = !!onReorder && projects.length > 1;
  const sensors = useSensors(
    // The whole row is the handle and it is full of links, so a drag only begins
    // once the pointer has actually travelled — a plain click still navigates
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // An expanded project is several times taller than a collapsed one, and dnd-kit
  // shifts the others by the dragged element's height — so the tree lurches. Everything
  // is collapsed for the duration and put back afterwards.
  const [expandedBeforeDrag, setExpandedBeforeDrag] = useState<string | null>(null);

  function handleDragStart() {
    // manuallyExpanded, not expandedId: the latter falls back to the route's project,
    // so storing it would pin an expansion the user never chose and kill
    // expand-on-navigate for the rest of the session
    setExpandedBeforeDrag(manuallyExpanded);
    setManuallyExpanded("");
  }

  function restoreExpanded() {
    setManuallyExpanded(expandedBeforeDrag);
    setExpandedBeforeDrag(null);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    restoreExpanded();
    if (!over) return;
    const next = reorderedIds(
      projects.map((p) => p._id),
      String(active.id),
      String(over.id),
    );
    if (next) onReorder?.(next);
  }

  return (
    <div>
      <div className="mb-1.5 ml-2.5 flex items-center gap-1">
        <Link
          href="/projects"
          className="focus-ring inline-flex min-h-[44px] items-center rounded text-[10.5px] font-bold uppercase tracking-wider text-text-muted transition-colors hover:text-text md:min-h-0"
        >
          Projects
        </Link>
        {isAdmin && (
          <Link
            href="/projects/new"
            title="New project"
            aria-label="New project"
            className="focus-ring ml-auto mr-2.5 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text md:min-h-0 md:min-w-0 md:p-0.5"
          >
            <SubIcon d={SUB_ICONS.plus} />
          </Link>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={restoreExpanded}
      >
      <SortableContext
        items={projects.map((p) => p._id)}
        strategy={verticalListSortingStrategy}
      >
      {projects.map((project) => {
        const expanded = expandedId === project._id;
        const isRouteProject = routeProject?._id === project._id;
        const base = projectPath(project.key);

        return (
          <SortableProject key={project._id} id={project._id} disabled={!canReorder}>
            {({ setNodeRef, handleProps, style, isDragging }) => (
          <div ref={setNodeRef} style={style}>
            <div
              data-active-project={isRouteProject || undefined}
              {...(canReorder ? handleProps : {})}
              className={`relative flex w-full items-center gap-1.5 rounded-lg pr-2.5 transition-colors hover:bg-bg-hover ${
                isRouteProject ? "shadow-[inset_3px_0_0_var(--color-primary)]" : ""
              } ${canReorder ? "cursor-grab touch-pan-y active:cursor-grabbing" : ""} ${
                isDragging ? "bg-bg-card shadow-lg ring-1 ring-border" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setManuallyExpanded(expanded ? "" : project._id)}
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                className="focus-ring flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-text-muted opacity-60 md:min-h-0 md:min-w-0 md:p-1.5"
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
                className="focus-ring-inset flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded py-2 text-sm text-text-muted transition-colors hover:text-text md:min-h-0"
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
                {(project.canAdmin ?? isAdmin) && (
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
            )}
          </SortableProject>
        );
      })}
      </SortableContext>
      </DndContext>
    </div>
  );
}
