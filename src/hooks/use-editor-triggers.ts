"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { escapeRegex } from "@/lib/escape-regex";
import type { Trigger } from "@/hooks/use-trigger-autocomplete";

interface Person {
  _id: string;
  username: string;
  fullName: string;
}

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
      ...(projectKey
        ? [
            {
              name: "task",
              pattern: new RegExp(
                `(?<![\\w-])${escapeRegex(projectKey)}-([A-Za-z0-9_-]{0,30})$`,
                "i"
              ),
              suggest: async (query: string) => {
                const tasks: { _id: string; taskNumber: number; title: string }[] = await api.get(
                  `/api/projects/${projectId}/tasks/suggest?q=${encodeURIComponent(query)}`
                );
                return tasks.map((t) => ({
                  id: t._id,
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
