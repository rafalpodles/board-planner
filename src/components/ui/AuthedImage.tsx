"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";

interface AuthedImageProps {
  src: string;
  alt: string;
  className?: string;
}

// /api/uploads/:id sits behind Basic auth held in sessionStorage, and a plain <img src>
// cannot send that header — it just 401s. So fetch the bytes and render an object URL.
export function AuthedImage({ src, alt, className }: AuthedImageProps) {
  const { getAuthHeader } = useAuth();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    const header = getAuthHeader();
    fetch(src, header ? { headers: { Authorization: header } } : undefined)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, getAuthHeader]);

  if (failed) {
    return (
      <div
        className={`${className ?? ""} flex items-center justify-center bg-bg-input text-[10px] text-text-muted`}
      >
        unavailable
      </div>
    );
  }

  if (!objectUrl) {
    return <div className={`${className ?? ""} animate-pulse bg-bg-input`} />;
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={objectUrl} alt={alt} className={className} />;
}
