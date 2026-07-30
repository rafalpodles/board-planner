import type { CSSProperties } from "react";
import { ApiProjectCategory } from "@/types";

export function categoryColor(
  categories: ApiProjectCategory[] | undefined,
  category: string | undefined
): string | undefined {
  if (!category) return undefined;
  return categories?.find((c) => c.name === category)?.color || undefined;
}

export function categoryTint(color: string | undefined): CSSProperties | undefined {
  return color ? ({ "--cat": color } as CSSProperties) : undefined;
}
