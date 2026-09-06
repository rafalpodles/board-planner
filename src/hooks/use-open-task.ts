"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTaskPath, projectRefFromPathname } from "@/lib/urls";

/**
 * Whether the full task page is what the reader is looking at.
 *
 * Nothing else can answer it. The address cannot: with the intercepting modal open over the
 * board, the URL is already the task's. A React context cannot either, because ⌘K and the PM
 * widget are mounted in the shell, above both task routes (BP-533) — so the page publishes the
 * fact here, and anything in the tree can read it.
 *
 * A count rather than a flag. Nothing in this tree mounts two task pages at once — one `children`
 * slot, and React tears the old subtree down inside the same commit — so the two behave alike
 * today, and no test can tell them apart. It is written as a count because the failure a flag
 * would have is silent: the page that leaves clears the flag the page that arrived just set.
 *
 * A second full-page task route, if one is ever added, has to call `useDeclareTaskPage` as well.
 * Forgetting it puts BP-521 back, quietly, and no test can guard a route that does not exist yet.
 */
let mountedTaskPages = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const onTaskPage = () => mountedTaskPages > 0;
// The server renders no page at all, and claiming otherwise here is a hydration mismatch
const onServer = () => false;

/** Said by the full task page route, which is the only thing that knows it is not the modal. */
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

/**
 * Opening a task from anywhere in the app.
 *
 * `router.push` is the right thing everywhere except the task page, where it is intercepted into
 * `@modal` while the page underneath re-renders for the new param — the same task drawn twice
 * (BP-521). Hiding that modal is not a fix: a soft navigation keeps an unmatched slot's state, so
 * the task waits there and reappears over whatever is opened next. A document load never arms it,
 * and is how a task key written in prose has always reached its task.
 *
 * A task on *another* board is a document load too, whatever page the reader is on. The
 * intercepting route lives under `projects/[projectId]`, so it would draw that task inside the
 * layout of the project being left: the modal takes its project from the params of a layout that
 * has not moved, while the task follows the new URL, and the two halves name different tasks
 * (BP-540). Leaving a board is a navigation, not an overlay on the board being left.
 *
 * Anything that is not a task — a project page from the same ⌘K list — is an ordinary push.
 */
export function useOpenTask() {
  const fromTaskPage = useSyncExternalStore(subscribe, onTaskPage, onServer);
  const router = useRouter();
  const pathname = usePathname();

  return useCallback(
    (href: string) => {
      const here = projectRefFromPathname(pathname);
      const there = projectRefFromPathname(href);
      // An id against a key cannot be told from two different boards, so a disagreement takes the
      // heavier way out. That costs a needless document load on the four routes which keep an
      // ObjectId in the address — /sprints, /dashboard, /settings, /pm, the ones `useCanonicalUrl`
      // does not rewrite — and it is the safe direction: the other way round would push a
      // genuinely cross-board task into the modal of the board being left, which is the bug.
      const anotherBoard = !!here && !!there && here.toLowerCase() !== there.toLowerCase();

      if (isTaskPath(href) && (fromTaskPage || anotherBoard)) window.location.assign(href);
      else router.push(href);
    },
    [fromTaskPage, pathname, router]
  );
}
