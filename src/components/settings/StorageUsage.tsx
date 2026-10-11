"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { ENTERPRISE_CONTACT, PAID_STORAGE_MB, formatStorage } from "@/lib/storage-size";

const MB = 1024 * 1024;

interface Storage {
  storedBytes: number;
  limitBytes: number | null;
  raisedBy: "pro" | "enterprise" | null;
}

export function StorageUsage() {
  const api = useApi();
  const [storage, setStorage] = useState<Storage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .get("/api/organisation/storage")
      .then((answer: Storage) => current && setStorage(answer))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const share = storage?.limitBytes ? Math.min(100, Math.floor((storage.storedBytes / storage.limitBytes) * 100)) : null;
  const full = storage?.limitBytes ? storage.storedBytes >= storage.limitBytes : false;

  return (
    <>
      <dt className="text-text-muted">Storage</dt>
      <dd className="min-w-0" data-testid="organisation-storage">
        {failed ? (
          <span className="text-danger">Could not be read.</span>
        ) : storage === null ? (
          <span className="text-text-muted" aria-busy="true">
            <span className="sr-only">Loading storage</span>
            <span aria-hidden="true">…</span>
          </span>
        ) : (
          <>
            <span className="tabular-nums" data-testid="organisation-storage-used">
              {formatStorage(storage.storedBytes)}
              {storage.limitBytes !== null ? ` of ${formatStorage(storage.limitBytes)}` : ""}
            </span>
            {share !== null && storage.limitBytes !== null && (
              <div
                role="progressbar"
                aria-label="File storage used"
                aria-valuemin={0}
                aria-valuemax={storage.limitBytes}
                aria-valuenow={Math.min(storage.storedBytes, storage.limitBytes)}
                aria-valuetext={`${formatStorage(storage.storedBytes)} of ${formatStorage(storage.limitBytes)}`}
                className="mt-1 h-2 w-full max-w-xs overflow-hidden rounded-full bg-bg-input"
              >
                <div className={`h-full ${share >= 90 ? "bg-danger" : "bg-primary"}`} style={{ width: `${share}%` }} />
              </div>
            )}
            {full && (
              <p className="mt-1 text-text-muted" data-testid="organisation-storage-full">
                Full, so no more files can be uploaded.
                {storage.raisedBy === "pro" && ` Upgrade to Pro for ${formatStorage(PAID_STORAGE_MB * MB)}.`}
                {storage.raisedBy === "enterprise" && (
                  <>
                    {" "}
                    Write to{" "}
                    <a href={`mailto:${ENTERPRISE_CONTACT}`} className="font-medium text-primary underline">
                      {ENTERPRISE_CONTACT}
                    </a>{" "}
                    about Enterprise for more.
                  </>
                )}
              </p>
            )}
            {!full && storage.raisedBy === "pro" && (
              <p className="mt-1 text-text-muted" data-testid="organisation-storage-free">
                Pro includes {formatStorage(PAID_STORAGE_MB * MB)}.
              </p>
            )}
          </>
        )}
      </dd>
    </>
  );
}
