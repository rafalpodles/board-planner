const MB = 1024 * 1024;

export const FREE_STORAGE_MB = 1024;
export const PAID_STORAGE_MB = 20480;
export const ENTERPRISE_CONTACT = "contact@board-planner.com";

export function formatStorage(bytes: number): string {
  const megabytes = Math.ceil(bytes / MB);
  if (megabytes < 1024) return `${megabytes} MB`;
  return `${Number((megabytes / 1024).toFixed(1))} GB`;
}
