import { expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";

/** A board whose history was written by the real status route: three finished, one in progress. */
export async function boardWithHistory(request: APIRequestContext, key: string) {
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: `Insights ${key}`, key } });
  expect(created.status(), await created.text()).toBe(201);
  const { _id: projectId } = (await created.json()) as { _id: string };

  const move = async (taskId: string, status: string) => {
    const res = await request.patch(`/api/projects/${projectId}/tasks/${taskId}/status`, { headers: ADMIN_AUTH, data: { status } });
    expect(res.status(), await res.text()).toBe(200);
  };
  const ids: Record<string, string> = {};
  for (const [title, category] of [
    ["Ship the export", "bug"],
    ["Write the guide", "doc"],
    ["Fix the redirect", "bug"],
    ["Still being built", "bug"],
  ] as const) {
    const task = await request.post(`/api/projects/${projectId}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title, status: "todo", category },
    });
    expect(task.status(), await task.text()).toBe(201);
    ids[title] = ((await task.json()) as { _id: string })._id;
  }
  for (const title of ["Ship the export", "Write the guide", "Fix the redirect"]) {
    await move(ids[title], "in_progress");
    await move(ids[title], "done");
  }
  await move(ids["Still being built"], "in_progress");
  return { projectId };
}
