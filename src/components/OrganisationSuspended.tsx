"use client";

import { useEffect, useRef } from "react";

export function OrganisationSuspended() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div role="status" className="w-full max-w-sm text-center">
        <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold mb-2">
          This organisation is suspended
        </h1>
        <p className="text-sm text-text">
          Its boards and data are kept, but nobody can sign in or use them until the service lifts the
          suspension. Contact the person who runs your account with the service.
        </p>
      </div>
    </div>
  );
}
