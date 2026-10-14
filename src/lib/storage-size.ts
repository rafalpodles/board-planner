const MB = 1024 * 1024;

export const FREE_STORAGE_MB = 1024;
export const PAID_STORAGE_MB = 20480;
export const ENTERPRISE_CONTACT = "contact@board-planner.com";

/** One file: rounded to what it is, where formatStorage rounds a total up so that it never reads below what is used */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * MB) return `${Number((bytes / MB).toFixed(1))} MB`;
  return `${Number((bytes / (1024 * MB)).toFixed(1))} GB`;
}

export function formatStorage(bytes: number): string {
  const megabytes = Math.ceil(bytes / MB);
  if (megabytes < 1024) return `${megabytes} MB`;
  return `${Number((megabytes / 1024).toFixed(1))} GB`;
}
