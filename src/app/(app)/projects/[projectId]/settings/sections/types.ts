import { ApiProject } from "@/types";

export interface SettingsStats {
  total: number;
  statusBreakdown: Record<string, number>;
  categoryBreakdown: Record<string, number>;
  customFieldUsage: Record<string, number>;
}

export interface SectionProps {
  projectId: string;
  project: ApiProject;
  patchProject: (
    patch: Partial<ApiProject> | ((prev: ApiProject) => Partial<ApiProject>)
  ) => void;
  replaceProject: (next: ApiProject) => void;
  isAdmin: boolean;
  /** Null until the first section that needs a count is opened */
  stats: SettingsStats | null;
}
