"use client";

import { createContext, useCallback, useContext } from "react";
import { useRouter } from "next/navigation";

/**
 * Which of the two routes is drawing the detail view. Only the route knows: on the board the URL
 * is the task's while the page underneath is still the board, so the address cannot be asked.
 *
 * `modal` is the default because it is the older behaviour, and because a view rendered outside
 * either route is not the full page.
 */
const TaskSurfaceContext = createContext<"page" | "modal">("modal");

export function TaskSurface({
  value,
  children,
}: {
  value: "page" | "modal";
  children: React.ReactNode;
}) {
  return <TaskSurfaceContext.Provider value={value}>{children}</TaskSurfaceContext.Provider>;
}

/**
 * Opening another task from the detail view.
 *
 * From the modal that is `router.push`, which swaps the modal and leaves the board underneath.
 * From the full page the same push is intercepted into `@modal` while the page re-renders for
 * the new param, so the task is drawn twice (BP-521) — and hiding that modal is not a fix, since
 * a soft navigation keeps an unmatched slot's state and the task waits there to reappear over
 * whatever is opened next. A document load is how the page is reached everywhere else: a task
 * key written in prose renders as a plain link, and has always worked this way.
 */
export function useOpenTask() {
  const surface = useContext(TaskSurfaceContext);
  const router = useRouter();

  return useCallback(
    (href: string) => {
      if (surface === "page") window.location.assign(href);
      else router.push(href);
    },
    [surface, router]
  );
}
