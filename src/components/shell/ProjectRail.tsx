"use client";

import Link from "next/link";
import { ApiProject, DEFAULT_PROJECT_ICON } from "@/types";
import { projectPath } from "@/lib/urls";
import { isNavItemActive } from "@/lib/nav-active";
import { SubIcon, projectSections } from "./ProjectTree";

const ALL_PROJECTS_ICON = "M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 10h16M10 10v10";

const ROW =
  "focus-ring relative flex h-9 w-full items-center justify-center rounded-lg transition-colors";

interface ProjectRailProps {
  projects: ApiProject[];
  pathname: string;
}

export function ProjectRail({ projects, pathname }: ProjectRailProps) {
  const routeProject = projects.find(
    (p) =>
      isNavItemActive(pathname, projectPath(p.key)) || isNavItemActive(pathname, projectPath(p._id)),
  );

  const onProjectList = !routeProject && isNavItemActive(pathname, "/projects");

  return (
    <div className="flex flex-col gap-px">
      <Link
        href="/projects"
        title="All projects"
        aria-label="All projects"
        aria-current={onProjectList ? "page" : undefined}
        className={`${ROW} ${
          onProjectList
            ? "bg-primary/15 text-primary"
            : "text-text-muted hover:bg-bg-hover hover:text-text"
        }`}
      >
        <SubIcon d={ALL_PROJECTS_ICON} />
      </Link>

      {projects.map((project) => {
        const isRouteProject = routeProject?._id === project._id;
        return (
          <div key={project._id} className="flex flex-col gap-px">
            <Link
              href={projectPath(project.key)}
              title={project.name}
              aria-label={project.name}
              data-active-project={isRouteProject || undefined}
              aria-current={isRouteProject ? "true" : undefined}
              className={`${ROW} text-[17px] leading-none ${
                isRouteProject
                  ? "bg-bg-hover shadow-[inset_3px_0_0_var(--color-primary)]"
                  : "opacity-70 hover:bg-bg-hover hover:opacity-100"
              }`}
            >
              <span aria-hidden>{project.icon || DEFAULT_PROJECT_ICON}</span>
            </Link>

            {isRouteProject && (
              <div
                role="group"
                aria-label={`${project.name} sections`}
                className="mx-auto flex w-7 flex-col gap-px border-l border-border pl-1"
              >
                {projectSections(project, pathname).map((section) => (
                  <Link
                    key={section.label}
                    href={section.href}
                    title={section.label}
                    aria-label={section.label}
                    aria-current={section.active ? "page" : undefined}
                    className={`focus-ring relative flex h-8 w-full items-center justify-center rounded-md transition-colors ${
                      section.active
                        ? "bg-primary/15 text-primary"
                        : "text-text-muted hover:bg-bg-hover hover:text-text"
                    }`}
                  >
                    <SubIcon d={section.icon} />
                    {section.dot && (
                      <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success" />
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
