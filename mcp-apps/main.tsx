import { useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./style.css";

type Person = string | { username?: string; fullName?: string } | null | undefined;
type Row = {
  key?: string; taskNumber?: number; title?: string; status?: string; category?: string;
  priority?: string; assignee?: Person; sprint?: string | { name?: string } | null;
  description?: string; dueDate?: string | null; url?: string;
  checklist?: { _id: string; text: string; done: boolean }[];
};
type Sprint = { id?: string; _id?: string; name: string; status?: string; goal?: string; startDate?: string; endDate?: string; taskCount?: number; doneCount?: number };
type Column = { id: string; label: string; color?: string };
type View = { tool: string; args: Record<string, unknown>; origin?: string; data: Record<string, unknown> | Sprint[]; columns?: Column[] };
type ViewMeta = { tool?: string; arguments?: Record<string, unknown>; origin?: string };

const VIEW_META = "boardplanner/view";
const app = new App({ name: "Board Planner", version: "1.0.0" }, {}, { autoResize: true });
const columnsByProject = new Map<string, Column[]>();
const sprintNames = new Map<string, string>();
const taskTools = new Set(["get_task", "create_task", "update_task", "change_task_status"]);
const priorityColor: Record<string, string> = { urgent: "#d93025", high: "#e8710a", medium: "#5b7bd5", low: "#8a93a3" };
const categoryColor: Record<string, string> = { bug: "#d93025", "user-story": "#2f9e5b", doc: "#3b7ddd", idea: "#d99a1e" };
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
  return payload(await app.callServerTool({ name, arguments: args })) as View["data"];
}
function prefix(key: string) { return key.slice(0, key.lastIndexOf("-")).toUpperCase(); }
function taskKey(view: View) {
  const row = view.data as Row;
  if (row.key) return row.key;
  const requested = String(view.args.taskKey ?? "");
  const project = String(view.args.project ?? prefix(requested));
  return row.taskNumber != null ? `${project.toUpperCase()}-${row.taskNumber}` : requested.toUpperCase();
}
async function withColumns(view: View): Promise<View> {
  const project = taskTools.has(view.tool) ? prefix(taskKey(view)) : String(view.args.project ?? "").toUpperCase();
  if (!project || !app.getHostCapabilities()?.serverTools) return view;
  if (!columnsByProject.has(project)) columnsByProject.set(project, ((await call("get_project", { identifier: project })) as { columns?: Column[] }).columns ?? []);
  const sprint = taskTools.has(view.tool) ? (view.data as Row).sprint : undefined;
  if (isId(sprint) && !sprintNames.has(sprint)) {
    for (const row of (await call("list_sprints", { project })) as unknown as Sprint[]) sprintNames.set(String(row.id ?? row._id), row.name);
  }
  return { ...view, columns: columnsByProject.get(project) };
}
function column(view: View, status: string) { return view.columns?.find((c) => c.id === status); }
function label(view: View, status: string) { return column(view, status)?.label ?? status.replaceAll("_", " "); }
function name(value: Person) { return typeof value === "string" ? value : value?.fullName || value?.username || ""; }
const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
function sprintName(value: Row["sprint"]) {
  if (typeof value === "string") return sprintNames.get(value) ?? (isId(value) ? "In a sprint" : value || "Backlog");
  return value?.name || "Backlog";
}
function taskUrl(view: View, key: string) {
  const parts = key.match(/^(.+)-(\d+)$/);
  if (!view.origin || !parts) return undefined;
  try {
    const base = new URL(view.origin);
    if (!["https:", "http:"].includes(base.protocol)) return undefined;
    return `${base.origin}/projects/${encodeURIComponent(parts[1])}/tasks/${parts[2]}`;
  } catch { return undefined; }
}
function shortDate(value?: string | null) {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : undefined;
}

async function receive(result: CallToolResult) {
  const id = ++generation;
  locked = true;
  history.length = 0;
  update(current, true, "");
  try {
    const data = payload(result) as View["data"];
    const meta = result._meta?.[VIEW_META] as ViewMeta | undefined;
    if (!meta?.tool) throw new Error("This result has no Board Planner view context.");
    let view: View = { tool: meta.tool, args: meta.arguments ?? {}, origin: meta.origin, data };
    // A write may answer with a minimal row or unpopulated refs: show the saved task.
    if (taskTools.has(view.tool) && view.tool !== "get_task" && app.getHostCapabilities()?.serverTools) view = { ...view, data: await call("get_task", { taskKey: taskKey(view) }) };
    view = await withColumns(view);
    if (id === generation) { current = view; update(current, false, ""); }
  } catch (error) {
    if (id === generation) update(current, false, error instanceof Error ? error.message : "Unable to load the view.");
  } finally { if (id === generation) locked = false; }
}
async function action(work: () => Promise<View>, parent?: View) {
  if (locked) return;
  locked = true;
  const id = generation;
  update(current, true, "");
  try {
    const view = await work();
    if (id === generation) {
      if (parent) history.push(parent);
      current = view; update(current, false, "");
    }
  } catch (error) {
    if (id === generation) update(current, false, error instanceof Error ? error.message : "The action failed.");
  } finally { if (id === generation) locked = false; }
}
function openTask(key: string) {
  const source = current!;
  void action(async () => withColumns({ ...source, tool: "get_task", args: { taskKey: key }, data: await call("get_task", { taskKey: key }), columns: undefined }), source);
}
async function reload(source: View, key: string): Promise<View> {
  return { ...source, data: await call("get_task", { taskKey: key }) };
}
function changeStatus(status: string) {
  const source = current!;
  const key = taskKey(source);
  void action(async () => {
    await call("change_task_status", { taskKey: key, status });
    return reload(source, key);
  });
}
function toggle(item: string, done: boolean) {
  const source = current!;
  const key = taskKey(source);
  void action(async () => {
    await call("set_checklist_item", { taskKey: key, item, done });
    return reload(source, key);
  });
}
function followPage(view: View, offset: number) {
  void action(async () => {
    const args = { ...view.args, offset };
    return { ...view, args, data: await call(view.tool, args) };
  });
}
function openSprint(view: View, sprint: Sprint) {
  void action(async () => {
    const args = { project: view.args.project, sprint: sprint.id ?? sprint._id };
    return { ...view, tool: "get_sprint", args, data: await call("get_sprint", args) };
  }, view);
}
function hostStyle(context?: McpUiHostContext) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
const bookmark = "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z";
const external = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";
const person = "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0";

function ExternalLink({ url, label: text, className, children }: { url?: string; label?: string; className?: string; children: ReactNode }) {
  if (!url) return null;
  return <a href={url} className={className} aria-label={text} title={text} onClick={(event) => {
    event.preventDefault();
    void app.openLink({ url }).catch((error: Error) => update(current, locked, error.message));
  }}>{children}</a>;
}
function Avatar({ value, size = 22 }: { value: Person; size?: number }) {
  const who = name(value);
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.45), "--hue": [...who].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7) } as CSSProperties;
  if (!who) return <span className="avatar empty" style={style} role="img" aria-label="Unassigned"><Icon d={person} size={size * 0.62} /></span>;
  const initials = who.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  return <span className="avatar" style={style} role="img" aria-label={who} title={who}>{initials}</span>;
}
function Assignee({ value }: { value: Person }) {
  return <span className="assignee"><Avatar value={value} />{name(value) || "Unassigned"}</span>;
}
function PriorityChip({ value = "medium" }: { value?: string }) {
  return <span className="chip"><span className="swatch" style={{ background: priorityColor[value] ?? priorityColor.medium }} aria-hidden="true" /><span className="sr-only">Priority: </span>{value[0].toUpperCase() + value.slice(1)}</span>;
}
function StatusSelect({ view, status = "", busy, interactive, onChange }: { view: View; status?: string; busy: boolean; interactive: boolean; onChange: (status: string) => void }) {
  const known = !!column(view, status);
  return <span className="select" style={{ "--col": column(view, status)?.color ?? "#6b7280" } as CSSProperties}>
    <select className="status" aria-label="Task status" value={status} disabled={!interactive || !view.columns?.length} aria-disabled={busy} onChange={(event) => onChange(event.target.value)}>
      {!known && <option value={status}>{label(view, status)}</option>}
      {view.columns?.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  </span>;
}
function Progress({ total = 0, done = 0, caption = true, name = "Tasks completed" }: { total?: number; done?: number; caption?: boolean; name?: string }) {
  return <div className="progress">
    {caption && <div className="progress-label"><strong>{done} of {total} done</strong><span>{total ? Math.round(done / total * 100) : 0}%</span></div>}
    <progress max={Math.max(total, 1)} value={done} aria-label={name} />
  </div>;
}

function TaskCard({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const row = view.data as Row;
  const key = taskKey(view);
  const category = row.category ?? "task";
  const checked = row.checklist?.filter((item) => item.done).length ?? 0;
  const due = shortDate(row.dueDate);
  return <article className="card">
    <header className="card-head">
      <span className="type" style={{ "--tone": categoryColor[category] ?? "#6b7280" } as CSSProperties} role="img" aria-label={category}><Icon d={bookmark} size={20} /></span>
      <div className="card-title">
        <h1>{row.title}</h1>
        <div className="meta">
          <span className="mono">{key}</span><span className="sep" aria-hidden="true">•</span>
          <Assignee value={row.assignee} /><span className="sep" aria-hidden="true">•</span>
          <StatusSelect view={view} status={row.status} busy={busy} interactive={interactive} onChange={changeStatus} />
        </div>
      </div>
      <ExternalLink url={taskUrl(view, key)} label="Open in Board Planner" className="open"><Icon d={external} size={18} /></ExternalLink>
    </header>
    <div className="chips">
      <PriorityChip value={row.priority} />
      <span className="chip"><span className="sr-only">Sprint: </span>{sprintName(row.sprint)}</span>
      <span className="chip"><span className="sr-only">Category: </span>{category}</span>
      {due && <span className="chip">Due {due}</span>}
    </div>
    {row.description && <section className="description" aria-label="Description"><Markdown remarkPlugins={[remarkGfm]} components={{
      img: ({ alt }) => <span>{alt}</span>,
      a: ({ href, children }) => <ExternalLink url={href}>{children}</ExternalLink>,
    }}>{row.description}</Markdown></section>}
    {!!row.checklist?.length && <section className="checklist" aria-label="Acceptance criteria">
      <h2>Acceptance criteria <span>{checked}/{row.checklist.length}</span></h2>
      <Progress total={row.checklist.length} done={checked} caption={false} name="Acceptance criteria completed" />
      {row.checklist.map((item) => <label key={item._id} className="criterion">
        <input type="checkbox" checked={item.done} disabled={!interactive} aria-disabled={busy} onChange={(event) => toggle(item._id, event.target.checked)} />
        <span className={item.done ? "completed" : ""}>{item.text}</span>
      </label>)}
    </section>}
  </article>;
}
function TaskList({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const data = view.data as { tasks?: Row[]; total?: number; returned?: number; nextOffset?: number | null; truncated?: boolean };
  const groups = new Map<string, Row[]>();
  for (const row of data.tasks ?? []) { const status = row.status ?? "Unknown"; groups.set(status, [...(groups.get(status) ?? []), row]); }
  const order = (status: string) => view.columns?.findIndex((c) => c.id === status) ?? 0;
  const offset = Number(view.args.offset ?? 0);
  return <section aria-label="Tasks">
    <p className="caption">{data.total != null ? `${data.tasks?.length ?? 0} of ${data.total} tasks` : `${data.returned ?? data.tasks?.length ?? 0} tasks`}</p>
    {!groups.size && <p className="empty-state">No tasks found.</p>}
    {[...groups].sort(([a], [b]) => order(a) - order(b)).map(([status, tasks]) => <section className="group" key={status}>
      <h2><span className="swatch" style={{ background: column(view, status)?.color ?? "#6b7280" }} aria-hidden="true" />{label(view, status)}<span className="count">{tasks.length}</span></h2>
      <div className="rows">{tasks.map((row, index) => {
        const key = row.key ?? `${String(view.args.project).toUpperCase()}-${row.taskNumber}`;
        return <button className="task-row" key={`${key}-${index}`} disabled={!interactive} aria-disabled={busy} onClick={() => openTask(key)}>
          <span className="mono">{key}</span>
          <span className="row-title">{row.title}</span>
          {view.tool !== "my_tasks" && <Avatar value={row.assignee} size={20} />}
          <span className="swatch" style={{ background: priorityColor[row.priority ?? "medium"] ?? priorityColor.medium }} aria-hidden="true" /><span className="sr-only">{row.priority ?? "medium"} priority</span>
        </button>;
      })}</div>
    </section>)}
    <div className="pagination">
      {offset > 0 && <button disabled={!interactive} aria-disabled={busy} onClick={() => followPage(view, Math.max(0, offset - Number(view.args.limit ?? 50)))}>Previous page</button>}
      {data.nextOffset != null && <button disabled={!interactive} aria-disabled={busy} onClick={() => followPage(view, data.nextOffset!)}>Next page</button>}
    </div>
    {data.truncated && <p className="caption">Search is limited to 50 matches. Refine your query to see other tasks.</p>}
  </section>;
}
function SprintView({ view, busy, interactive }: { view: View; busy: boolean; interactive: boolean }) {
  const one = view.data as { sprint: Sprint };
  const sprints = Array.isArray(view.data) ? view.data : [one.sprint];
  return <section aria-label="Sprints">
    {!sprints.length && <p className="empty-state">No sprints yet.</p>}
    {sprints.map((sprint) => <article className="card sprint" key={sprint.id ?? sprint._id}>
      <div className="sprint-header">
        <h2>{view.tool === "list_sprints" ? <button className="link" disabled={!interactive} aria-disabled={busy} onClick={() => openSprint(view, sprint)}>{sprint.name} ›</button> : sprint.name}</h2>
        <span className="chip">{sprint.status}</span>
      </div>
      <p className="caption">{shortDate(sprint.startDate)} – {shortDate(sprint.endDate)}</p>
      {sprint.goal && <p>{sprint.goal}</p>}
      <Progress total={sprint.taskCount} done={sprint.doneCount} />
    </article>)}
    {view.tool === "get_sprint" && <TaskList view={view} busy={busy} interactive={interactive} />}
  </section>;
}
function Stats({ view }: { view: View }) {
  const stats = view.data as { total: number; done: number; statusBreakdown?: Record<string, number>; velocity?: { week: string; count: number }[] };
  const order = (status: string) => view.columns?.findIndex((c) => c.id === status) ?? 0;
  const peak = Math.max(1, ...(stats.velocity ?? []).map((week) => week.count));
  return <section aria-label="Project statistics" className="card">
    <h1 className="plain">{String(view.args.project)} overview</h1>
    <div className="tiles">
      <div><strong>{stats.total}</strong><span>Tasks</span></div>
      <div><strong>{stats.done}</strong><span>Done</span></div>
      <div><strong>{stats.total ? Math.round(stats.done / stats.total * 100) : 0}%</strong><span>Complete</span></div>
    </div>
    <Progress total={stats.total} done={stats.done} caption={false} />
    <h2>Status distribution</h2>
    {Object.entries(stats.statusBreakdown ?? {}).sort(([a], [b]) => order(a) - order(b)).map(([status, count]) => <div className="distribution" key={status}>
      <span>{label(view, status)}</span>
      <div className="bar" role="meter" aria-label={`${label(view, status)}: ${count} tasks`} aria-valuemin={0} aria-valuemax={Math.max(stats.total, 1)} aria-valuenow={count}>
        <i style={{ width: `${Math.max(2, count / Math.max(stats.total, 1) * 100)}%`, background: column(view, status)?.color ?? "#6b7280" }} />
      </div>
      <strong>{count}</strong>
    </div>)}
    {!!stats.velocity?.length && <><h2>Completed per week</h2><div className="weeks">{stats.velocity.map((week) => <div key={week.week}>
      <strong>{week.count}</strong><i style={{ height: `${Math.max(4, week.count / peak * 56)}px` }} /><span>{week.week}</span>
    </div>)}</div></>}
  </section>;
}
function Skeleton() {
  return <div className="card skeleton" aria-hidden="true"><i style={{ width: "62%" }} /><i style={{ width: "38%" }} /><i /><i style={{ width: "80%" }} /></div>;
}
function Widget() {
  const [state, setState] = useState<{ view?: View; busy: boolean; error: string }>({ busy: true, error: "" });
  update = (view, busy, error) => setState({ view, busy, error });
  const { view, busy, error } = state;
  const interactive = !!app.getHostCapabilities()?.serverTools;
  return <main aria-busy={busy} className={busy && view ? "busy" : ""}>
    <span className="sr-only" role="status">{busy ? "Loading…" : ""}</span>
    {!!history.length && <button className="back" aria-disabled={busy} onClick={() => { if (locked) return; current = history.pop(); update(current, false, ""); }}>← Back</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {!view && !error && <Skeleton />}
    {view && (taskTools.has(view.tool) ? <TaskCard view={view} busy={busy} interactive={interactive} /> : view.tool === "get_project_stats" ? <Stats view={view} /> : ["get_sprint", "list_sprints"].includes(view.tool) ? <SprintView view={view} busy={busy} interactive={interactive} /> : <TaskList view={view} busy={busy} interactive={interactive} />)}
    {view && !interactive && <p className="caption">This host displays the view without tool interactions.</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Widget />);
app.ontoolresult = receive;
app.onhostcontextchanged = hostStyle;
app.ontoolcancelled = () => { ++generation; locked = false; update(current, false, "The request was cancelled."); };
app.connect().then(() => hostStyle(app.getHostContext())).catch((error: Error) => update(current, false, error.message));
