"use client";

import { useCallback, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { auditQuery, NO_AUDIT_FILTERS, type AuditFilterValues } from "@/components/audit/AuditFilters";

/**
 * A page at a time, at the route's own page size. A full page says another may follow; the cursor is
 * the last row's id, so the next page starts strictly after it however many rows arrived in between.
 */
export function useAuditLog<T extends { _id: string }>(url: string, pageSize: number) {
  const api = useApi();
  const [rows, setRows] = useState<T[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [filters, setFilters] = useState<AuditFilterValues>(NO_AUDIT_FILTERS);
  const seq = useRef(0);

  const read = useCallback(
    async (applied: AuditFilterValues, after: T[] | null) => {
      const mine = ++seq.current;
      setLoading(true);
      setFailed(false);
      const before = after?.length ? after[after.length - 1]._id : "";
      try {
        const page: T[] = await api.get(`${url}${auditQuery(applied, { before })}`);
        if (mine !== seq.current) return;
        setRows([...(after ?? []), ...page]);
        setMore(page.length === pageSize);
        setFailed(false);
      } catch {
        if (mine !== seq.current) return;
        setFailed(true);
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setAnswered(true);
        }
      }
    },
    [api, url, pageSize]
  );

  const apply = useCallback(
    (applied: AuditFilterValues) => {
      setFilters(applied);
      setRows(null);
      setMore(false);
      return read(applied, null);
    },
    [read]
  );

  const reload = useCallback(() => apply(filters), [apply, filters]);
  const loadMore = useCallback(() => read(filters, rows), [read, filters, rows]);

  return { rows, more, loading, failed, answered, filters, apply, reload, loadMore };
}
