import { ApiProject } from "@/types";

export interface SectionProps {
  projectId: string;
  project: ApiProject;
  patchProject: (patch: Partial<ApiProject>) => void;
  replaceProject: (next: ApiProject) => void;
  isAdmin: boolean;
}
