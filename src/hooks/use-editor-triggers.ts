"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import type { Trigger } from "@/hooks/use-trigger-autocomplete";

interface Person {
  _id: string;
  username: string;
  fullName: string;
}

/**
 * What every editor in a project offers: `@` for the people who can be mentioned, and the board's
 * own key for the tasks that can be referred to.
 *
 * Shared so the comment composer and the description editor cannot drift apart — the mention half
 * lived inside Comments and reached nowhere else, which is why a description never offered one.
 */
export function useEditorTriggers(projectId: string, projectKey?: string): Trigger[] {
  const api = useApi();
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/assignable-users`)
      .then(setPeople)
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return useMemo(
    () => [
      {
        name: "mention",
        // Unchanged from when it lived inline: an `@` anywhere before the caret, matched against
        // username and full name alike
        pattern: /@([a-zA-Z0-9_-]*)$/,
        suggest: (query: string) =>
          people
            .filter(
              (u) =>
                u.username.toLowerCase().includes(query.toLowerCase()) ||
                u.fullName.toLowerCase().includes(query.toLowerCase())
            )
            .slice(0, 5)
            .map((u) => ({
              id: u._id,
              insert: `@${u.username}`,
              label: u.username,
              hint: u.fullName,
            })),
      },
      // The board's own key, so the trigger is whatever this project is called. Only the current
      // key: a former one is a way of recognising what somebody already wrote, not something to
      // offer them now.
      ...(projectKey
        ? [
            {
              name: "task",
              // Zero-width guard, because the whole match is what insertion replaces — a consuming
              // one would swallow the space before the key and paste the word onto it.
              // Case-insensitive, like the rendering and like every other key comparison here.
              pattern: new RegExp(`(?<![\\w-])${projectKey}-([A-Za-z0-9_-]{0,30})$`, "i"),
              suggest: async (query: string) => {
                const tasks: { _id: string; taskNumber: number; title: string }[] = await api.get(
                  `/api/projects/${projectId}/tasks/suggest?q=${encodeURIComponent(query)}`
                );
                return tasks.map((t) => ({
                  id: t._id,
                  // Plain text, never a markdown link: the key is what gets stored and the link is
                  // made when it is rendered, so renaming a project does not rewrite every
                  // description that mentions it
                  insert: `${projectKey}-${t.taskNumber}`,
                  label: `${projectKey}-${t.taskNumber}`,
                  hint: t.title,
                }));
              },
            },
          ]
        : []),
    ],
    [people, projectId, projectKey, api]
  );
}
