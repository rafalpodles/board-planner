"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTaskPath, projectRefFromPathname } from "@/lib/urls";

let mountedTaskPages = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const onTaskPage = () => mountedTaskPages > 0;
const onServer = () => false;

export function useDeclareTaskPage(): void {
  useEffect(() => {
    mountedTaskPages += 1;
    for (const listener of listeners) listener();
    return () => {
      mountedTaskPages -= 1;
      for (const listener of listeners) listener();
    };
  }, []);
}

export function useOpenTask() {
  const fromTaskPage = useSyncExternalStore(subscribe, onTaskPage, onServer);
  const router = useRouter();
  const pathname = usePathname();

  return useCallback(
    (href: string) => {
      const here = projectRefFromPathname(pathname);
      const there = projectRefFromPathname(href);
      const anotherBoard = !!here && !!there && here.toLowerCase() !== there.toLowerCase();

      if (isTaskPath(href) && (fromTaskPage || anotherBoard)) window.location.assign(href);
      else router.push(href);
    },
    [fromTaskPage, pathname, router]
  );
}
