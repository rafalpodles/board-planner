"use client";

import { ReactNode } from "react";
import { ProjectsContext, useProjectsProvider } from "@/hooks/use-projects";

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const projects = useProjectsProvider();
  return (
    <ProjectsContext.Provider value={projects}>
      {children}
    </ProjectsContext.Provider>
  );
}
