import { useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./style.css";

type Row = {
  key?: string; taskNumber?: number; title?: string; status?: string; category?: string;
  priority?: string; assignee?: string | { username?: string; fullName?: string } | null;
  sprint?: string | { name?: string } | null; description?: string; url?: string;
  checklist?: { _id: string; text: string; done: boolean }[];
};
type Sprint = { id?: string; _id?: string; name: string; status?: string; goal?: string; startDate?: string; endDate?: string; taskCount?: number; doneCount?: number };
type Column = { id: string; label: string; color?: string };
type View = { tool: string; args: Record<string, unknown>; origin?: string; data: Record<string, unknown> | Sprint[]; columns?: Column[] };
const app = new App({ name: "Board Planner", version: "1.0.0" }, {}, { autoResize: true });
const taskTools = new Set(["get_task", "create_task", "update_task", "change_task_status"]);
let generation = 0;
let locked = false;
let current: View | undefined;
const history: View[] = [];
let update: (view: View | undefined, busy: boolean, error: string) => void = () => {};

function payload(result: CallToolResult): unknown {
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  if (result.isError) throw new Error(text || "The tool refused this request.");
  try { return JSON.parse(text); } catch { throw new Error("Board Planner returned an unreadable result."); }
}
async function call(name: string, args: Record<string, unknown>) {
  return payload(await app.callServerTool({ name, arguments: args }));
}
function prefix(key: string) { return key.slice(0, key.lastIndexOf("-")).toUpperCase(); }
function taskKey(view: View) {
  const row = view.data as Row;
  if (row.key) return row.key;
  const requested = String(view.args.taskKey ?? "");
  const project = String(view.args.project ?? prefix(requested));
  return row.taskNumber != null ? `${project.toUpperCase()}-${row.taskNumber}` : requested.toUpperCase();
}
function label(view: View, status: string) { return view.columns?.find((c) => c.id === status)?.label ?? status.replaceAll("_", " "); }
function person(value: Row["assignee"]) { return typeof value === "string" ? value : value?.fullName || value?.username || "Unassigned"; }
function sprintName(value: Row["sprint"]) { return typeof value === "string" ? value : value?.name || "Backlog"; }
function taskUrl(view: View, key: string) {
  if (!view.origin || !key.includes("-")) return undefined;
  const parts = key.match(/^(.+)-(\d+)$/);
  if (!parts) return undefined;
  try {
    const base = new URL(view.origin);
    if (!["https:", "http:"].includes(base.protocol)) return undefined;
    return `${base.origin}/projects/${encodeURIComponent(parts[1])}/tasks/${parts[2]}`;
  } catch { return undefined; }
}
async function prepare(view: View) {
  if (taskTools.has(view.tool) && app.getHostCapabilities()?.serverTools) {
    const key = taskKey(view);
    // Writes may answer with a minimal row or unpopulated refs. Read the resulting card once.
    if (view.tool !== "get_task") view = { ...view, data: await call("get_task", { taskKey: key }) as View["data"] };
    const project = await call("get_project", { identifier: prefix(key) }) as { columns?: Column[] };
    view = { ...view, columns: project.columns };
  }
  return view;
}
async function receive(result: CallToolResult) {
  const id = ++generation;
  locked = true;
  history.length = 0;
  update(current, true, "");
  try {
    const meta = result._meta?.["boardplanner/view"] as { tool?: string; arguments?: Record<string, unknown>; origin?: string } | undefined;
    if (!meta?.tool) throw new Error("This result has no Board Planner view context.");
    const view = await prepare({ tool: meta.tool, args: meta.arguments ?? {}, origin: meta.origin, data: payload(result) as View["data"] });
    if (id === generation) { current = view; update(current, false, ""); }
  } catch (error) {
    if (id === generation) update(current, false, error instanceof Error ? error.message : "Unable to load the view.");
  } finally { if (id === generation) locked = false; }
}
async function action(work: () => Promise<View>, success = "") {
  if (locked) return;
  locked = true;
  const id = generation;
  update(current, true, "");
  try {
    const view = await work();
    if (id === generation) { current = view; update(current, false, success); }
  } catch (error) {
    if (id === generation) update(current, false, error instanceof Error ? error.message : "The action failed.");
  } finally { if (id === generation) locked = false; }
}
function openTask(key: string) {
  const source = current!;
  void action(async () => {
    const view = await prepare({ ...source, tool: "get_task", args: { taskKey: key }, data: await call("get_task", { taskKey: key }) as View["data"] });
    history.push(source);
    return view;
  });
}
function changeStatus(status: string) {
  const view = current!;
  const key = taskKey(view);
  void action(async () => {
    await call("change_task_status", { taskKey: key, status });
    return { ...view, data: await call("get_task", { taskKey: key }) as View["data"] };
  });
}
function toggle(item: string, done: boolean) {
  const view = current!;
  const key = taskKey(view);
  void action(async () => {
    await call("set_checklist_item", { taskKey: key, item, done });
    return { ...view, data: await call("get_task", { taskKey: key }) as View["data"] };
  });
}
function followPage(view: View, offset: number) {
  void action(async () => ({ ...view, args: { ...view.args, offset }, data: await call(view.tool, { ...view.args, offset }) as View["data"] }));
}
function openSprint(view: View, sprint: Sprint) {
  void action(async () => {
    const args = { project: view.args.project, sprint: sprint.id ?? sprint._id };
    const data = await call("get_sprint", args) as View["data"];
    history.push(view);
    return { ...view, tool: "get_sprint", args, data };
  });
}
function hostStyle(context?: McpUiHostContext) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
function ExternalLink({ url, children }: { url?: string; children: React.ReactNode }) {
  if (!url) return null;
  return <a href={url} onClick={(event) => {
    event.preventDefault();
    void app.openLink({ url }).catch((error: Error) => update(current, false, error.message));
  }}>{children}</a>;
}
function TaskCard({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const row = view.data as Row;
  const key = taskKey(view);
  const checked = row.checklist?.filter((item) => item.done).length ?? 0;
  return <article className="card">
    <div className="eyebrow"><span className="mono">{key}</span><span>{row.category ?? "Task"}</span></div>
    <h1>{row.title}</h1>
    <div className="properties">
      <label className="property"><span>Status</span><select aria-label="Task status" value={row.status ?? ""} disabled={busy || !interactive || !view.columns?.length} onChange={(event) => changeStatus(event.target.value)}>
        {!view.columns?.some((c) => c.id === row.status) && <option value={row.status}>{label(view, row.status ?? "")}</option>}
        {view.columns?.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
      </select></label>
      <div className="property"><span>Assignee</span><strong>{person(row.assignee)}</strong></div>
      <div className="property"><span>Priority</span><strong>{row.priority ?? "medium"}</strong></div>
      <div className="property"><span>Sprint</span><strong>{sprintName(row.sprint)}</strong></div>
    </div>
    {row.description && <section className="description" aria-label="Description"><Markdown remarkPlugins={[remarkGfm]} components={{
      // Raw HTML is never enabled; remote images cannot bypass the resource's empty CSP.
      img: ({ alt }) => <span>{alt}</span>,
      a: ({ href, children }) => <ExternalLink url={href}>{children}</ExternalLink>,
    }}>{row.description}</Markdown></section>}
    {!!row.checklist?.length && <section className="checklist" aria-label="Acceptance criteria"><h2>Acceptance criteria <span>{checked}/{row.checklist.length}</span></h2>
      {row.checklist.map((item) => <label key={item._id} className="criterion"><input type="checkbox" checked={item.done} disabled={busy || !interactive} onChange={(event) => toggle(item._id, event.target.checked)} /><span className={item.done ? "completed" : ""}>{item.text}</span></label>)}
    </section>}
    <footer><ExternalLink url={taskUrl(view, key)}>Open in Board Planner ↗</ExternalLink></footer>
  </article>;
}
function TaskList({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const data = view.data as { tasks?: Row[]; total?: number; returned?: number; nextOffset?: number | null; truncated?: boolean };
  const groups = new Map<string, Row[]>();
  for (const row of data.tasks ?? []) { const status = row.status ?? "Unknown"; groups.set(status, [...(groups.get(status) ?? []), row]); }
  return <section aria-label="Tasks"><p className="caption">{data.total != null ? `${data.tasks?.length ?? 0} of ${data.total} tasks` : `${data.returned ?? data.tasks?.length ?? 0} tasks`}</p>
    {!groups.size && <p>No tasks found.</p>}
    {[...groups].map(([status, tasks]) => <section className="group" key={status}><h2>{label(view, status)} <span>{tasks.length}</span></h2>
      {tasks.map((row, index) => {
        const key = row.key ?? `${String(view.args.project).toUpperCase()}-${row.taskNumber}`;
        return <button className="task-row" key={`${key}-${index}`} disabled={busy || !interactive} onClick={() => openTask(key)}><span className="mono">{key}</span><span className="row-title">{row.title}</span><span className="row-meta">{person(row.assignee)} · {row.priority ?? "medium"}</span><span aria-hidden="true">›</span></button>;
      })}
    </section>)}
    <div className="pagination">
      {Number(view.args.offset ?? 0) > 0 && <button disabled={busy || !interactive} onClick={() => followPage(view, Math.max(0, Number(view.args.offset) - Number(view.args.limit ?? 50)))}>Previous page</button>}
      {data.nextOffset != null && <button disabled={busy || !interactive} onClick={() => followPage(view, data.nextOffset!)}>Next page</button>}
    </div>
    {data.truncated && <p className="caption">Search is limited to 50 matches. Refine your query to see other tasks.</p>}
  </section>;
}
function Progress({ total = 0, done = 0 }: { total?: number; done?: number }) {
  return <div className="progress"><div className="progress-label"><strong>{done} of {total} done</strong><span>{total ? Math.round(done / total * 100) : 0}%</span></div><progress max={Math.max(total, 1)} value={done} aria-label="Tasks completed" /></div>;
}
function SprintView({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const one = view.data as { sprint: Sprint };
  const sprints = Array.isArray(view.data) ? view.data : [one.sprint];
  return <section aria-label="Sprints">{!sprints.length && <p>No sprints yet.</p>}{sprints.map((sprint) => <article className="sprint" key={sprint.id ?? sprint._id}>
    <div className="sprint-header"><h2>{view.tool === "list_sprints" ? <button disabled={busy || !interactive} onClick={() => openSprint(view, sprint)}>{sprint.name} ›</button> : sprint.name}</h2><span className="chip">{sprint.status}</span></div>
    <p className="caption">{sprint.startDate?.slice(0, 10)} – {sprint.endDate?.slice(0, 10)}</p>
    {sprint.goal && <p>{sprint.goal}</p>}<Progress total={sprint.taskCount} done={sprint.doneCount} />
  </article>)}{view.tool === "get_sprint" && <TaskList view={view} busy={busy} interactive={interactive} />}</section>;
}
function Stats({ view }: { view: View }) {
  const stats = view.data as { total: number; done: number; statusBreakdown?: Record<string, number>; velocity?: { week: string; count: number }[] };
  return <section aria-label="Project statistics"><h1>{String(view.args.project)} overview</h1><Progress total={stats.total} done={stats.done} />
    <h2>Status distribution</h2>{Object.entries(stats.statusBreakdown ?? {}).map(([status, count]) => <div className="distribution" key={status}><span>{label(view, status)}</span><meter min={0} max={Math.max(stats.total, 1)} value={count} aria-label={`${status}: ${count} tasks`} /><strong>{count}</strong></div>)}
    {!!stats.velocity?.length && <><h2>Completed per week</h2><div className="weeks">{stats.velocity.map((week) => <div key={week.week}><strong>{week.count}</strong><span>{week.week}</span></div>)}</div></>}
  </section>;
}
function Widget() {
  const [state, setState] = useState<{ view?: View; busy: boolean; error: string }>({ busy: true, error: "" });
  update = (view, busy, error) => setState({ view, busy, error });
  const { view, busy, error } = state;
  const interactive = !!app.getHostCapabilities()?.serverTools;
  return <main aria-busy={busy}><header className="toolbar"><span className="brand">Board Planner</span><div>
    {!!history.length && <button disabled={busy} onClick={() => { current = history.pop(); update(current, false, ""); }}>← Back</button>}
    <span role="status">{busy ? "Loading…" : ""}</span>
  </div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {view && !interactive && <p className="caption">This host displays the view without tool interactions.</p>}
    {view && (taskTools.has(view.tool) ? <TaskCard view={view} busy={busy} interactive={interactive} /> : view.tool === "get_project_stats" ? <Stats view={view} /> : ["get_sprint", "list_sprints"].includes(view.tool) ? <SprintView view={view} busy={busy} interactive={interactive} /> : <TaskList view={view} busy={busy} interactive={interactive} />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Widget />);
app.ontoolresult = receive;
app.onhostcontextchanged = hostStyle;
app.ontoolcancelled = () => { ++generation; locked = false; update(current, false, "The request was cancelled."); };
app.connect().then(() => hostStyle(app.getHostContext())).catch((error: Error) => update(current, false, error.message));
