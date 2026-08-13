"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { useProjects } from "@/hooks/use-projects";
import {
  Agent,
  BUCKETS,
  Block,
  CAPABILITIES,
  GATE_KINDS,
  MODELS,
  emptyComposition,
  gateKindByKey,
} from "./catalog";
import { useStore } from "./store";

type Tab = "agents" | "gates" | "steps";

const TABS: { id: Tab; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "gates", label: "Gates" },
  { id: "steps", label: "Steps" },
];

const MINE_SCOPE = "mine";

function DefaultBadge() {
  return (
    <span className="shrink-0 rounded bg-bg-input px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
      default
    </span>
  );
}

function paramSummary(block: Block): string {
  if (block.kind === "step") {
    if (block.deterministic) return "no model";
    const cap = CAPABILITIES.find((c) => c.value === block.capability)?.label ?? "";
    return [cap.toLowerCase(), block.model].filter(Boolean).join(" · ");
  }
  if (!block.params) return "";
  const kind = block.gateKind ? gateKindByKey(block.gateKind) : undefined;
  if (!kind) return "";
  return kind.params
    .map((p) => {
      const value = block.params?.[p.key];
      if (!value) return null;
      const label = p.type === "select" ? p.options?.find((o) => o.value === value)?.label : value;
      return `${p.label.toLowerCase()} ${label}`;
    })
    .filter(Boolean)
    .join(" · ");
}

function BlockList({ rows }: { rows: Block[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-card">
      {rows.map((row) => {
        const summary = paramSummary(row);
        return (
          <li key={row.key} className="px-3.5 py-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium">{row.name}</span>
              {row.builtIn && <DefaultBadge />}
              {summary && <span className="ml-auto shrink-0 text-[11px] text-text-muted">{summary}</span>}
            </div>
            <p className="mt-0.5 text-[13px] text-text-muted">{row.description}</p>
          </li>
        );
      })}
    </ul>
  );
}

function summarise(agent: Agent): string {
  const count = BUCKETS.reduce((n, b) => n + agent.composition[b.id].length, 0);
  return count === 0 ? "Nothing in it yet" : `${count} in sequence`;
}

function AgentList({ rows, empty }: { rows: Agent[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3.5 py-6 text-center text-[13px] text-text-muted">
        {empty}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-card">
      {rows.map((agent) => (
        <li key={agent.id}>
          <Link
            href={`/agents/${agent.id}`}
            className="focus-ring block px-3.5 py-3 transition-colors hover:bg-bg-hover"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium">{agent.name}</span>
              {agent.projectName && (
                <span className="text-[11px] text-text-muted">{agent.projectName}</span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-text-muted">{summarise(agent)}</span>
            </div>
            <p className="mt-0.5 text-[13px] text-text-muted">
              {agent.description || "No description yet."}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">{title}</h2>
      <p className="mb-2.5 mt-1 text-[13px] text-text-muted">{hint}</p>
      {children}
    </section>
  );
}

export default function AgentsPage() {
  const { projects } = useProjects();
  const [tab, setTab] = useState<Tab>("agents");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    agents: null,
    gates: null,
    steps: null,
  });

  const store = useStore();

  const [dialog, setDialog] = useState<Tab | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState(MINE_SCOPE);
  const [gateKind, setGateKind] = useState(GATE_KINDS[0].key);
  const [params, setParams] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [capability, setCapability] = useState<string>(CAPABILITIES[0].value);
  const [stepModel, setStepModel] = useState<string>(MODELS[0].value);

  const mine = store.allAgents.filter((a) => a.scope === "mine");
  const perProject = store.allAgents.filter((a) => a.scope === "project");
  const global = store.allAgents.filter((a) => a.scope === "global");
  const kind = gateKindByKey(gateKind);

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const order = TABS.map((t) => t.id);
    const i = order.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === "ArrowRight") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(i - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  const close = () => {
    setDialog(null);
    setName("");
    setDescription("");
    setScope(MINE_SCOPE);
    setGateKind(GATE_KINDS[0].key);
    setParams({});
    setPrompt("");
    setCapability(CAPABILITIES[0].value);
    setStepModel(MODELS[0].value);
  };

  const createAgent = () => {
    const project = projects.find((p) => p._id === scope);
    store.addAgent({
      id: `agent-${Date.now()}`,
      name: name.trim(),
      description: description.trim(),
      scope: project ? "project" : "mine",
      projectId: project?._id,
      projectName: project?.name,
      composition: emptyComposition(),
    });
    close();
  };

  const createGate = () => {
    store.addGate({
      key: `gate-${Date.now()}`,
      kind: "gate",
      name: name.trim(),
      description: description.trim() || kind?.description || "",
      builtIn: false,
      gateKind,
      params,
    });
    close();
  };

  const createStep = () => {
    store.addStep({
      key: `step-${Date.now()}`,
      kind: "step",
      name: name.trim(),
      description: description.trim(),
      builtIn: false,
      prompt: prompt.trim(),
      capability,
      model: stepModel,
    });
    close();
  };

  const action =
    tab === "agents"
      ? { label: "New agent", onClick: () => setDialog("agents") }
      : tab === "gates"
        ? { label: "New gate", onClick: () => setDialog("gates") }
        : { label: "New step", onClick: () => setDialog("steps") };

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Ways of getting a task done"
        actions={
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        }
      />

      <div role="tablist" aria-label="Catalog" className="mb-6 flex gap-6 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`catalog-tab-${t.id}`}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            aria-selected={tab === t.id}
            aria-controls={`catalog-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={handleKeyDown}
            onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-0.5 pb-2.5 text-sm transition-colors ${
              tab === t.id
                ? "border-primary font-semibold text-text"
                : "border-transparent text-text-muted hover:border-border hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="catalog-agents" aria-labelledby="catalog-tab-agents" hidden={tab !== "agents"}>
        <Section title="Mine" hint="Agents you created. Only you can pick them.">
          <AgentList rows={mine} empty="You have not created an agent yet." />
        </Section>
        <Section title="Per project" hint="Created by a project owner, and usable only on that project.">
          <AgentList rows={perProject} empty="No project has its own agent." />
        </Section>
        <Section title="Global" hint="Ship with Board Planner. Available on every project.">
          <AgentList rows={global} empty="None." />
        </Section>
      </div>

      <div role="tabpanel" id="catalog-gates" aria-labelledby="catalog-tab-gates" hidden={tab !== "gates"}>
        <Section
          title="Gates"
          hint="Checks that can stop a change. A gate never edits anything — it only says yes or no."
        >
          <BlockList rows={store.allGates} />
        </Section>
      </div>

      <div role="tabpanel" id="catalog-steps" aria-labelledby="catalog-tab-steps" hidden={tab !== "steps"}>
        <Section title="Steps" hint="Work an agent does. Each step is its own session, with a fresh head.">
          <BlockList rows={store.allSteps} />
        </Section>
      </div>

      <Modal open={dialog === "agents"} onClose={close} title="New agent">
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Careful with migrations"
            autoFocus
            required
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="When you would reach for this one"
            rows={3}
          />
          <Select
            label="Who can use it"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: MINE_SCOPE, label: "Only me" },
              ...projects.map((p) => ({ value: p._id, label: `Everyone on ${p.name}` })),
            ]}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={createAgent} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={dialog === "gates"} onClose={close} title="New gate">
        <div className="flex flex-col gap-4">
          <Select
            label="What it checks"
            value={gateKind}
            onChange={(e) => {
              setGateKind(e.target.value);
              setParams({});
            }}
            options={GATE_KINDS.map((k) => ({ value: k.key, label: k.name }))}
          />
          <p className="-mt-2 text-[12px] text-text-muted">{kind?.description}</p>

          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind ? `${kind.name}, stricter` : ""}
            required
          />

          {kind?.params.map((p) =>
            p.type === "select" ? (
              <Select
                key={p.key}
                label={p.label}
                value={params[p.key] ?? p.options?.[0]?.value ?? ""}
                onChange={(e) => setParams((v) => ({ ...v, [p.key]: e.target.value }))}
                options={p.options ?? []}
              />
            ) : (
              <div key={p.key}>
                <Input
                  label={p.label}
                  type={p.type === "number" ? "number" : "text"}
                  value={params[p.key] ?? ""}
                  placeholder={p.placeholder}
                  onChange={(e) => setParams((v) => ({ ...v, [p.key]: e.target.value }))}
                />
                {p.hint && <p className="mt-1 text-[12px] text-text-muted">{p.hint}</p>}
              </div>
            )
          )}

          {kind?.params.length === 0 && (
            <p className="text-[12px] text-text-muted">This one has nothing to set.</p>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={createGate} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={dialog === "steps"} onClose={close} title="New step">
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Write the tests"
            autoFocus
            required
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One line, so it reads in a list"
            rows={2}
          />
          <Textarea
            label="What it should do"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Read the change already committed and write tests that would have caught it failing."
            rows={4}
          />
          <Select
            label="Model"
            value={stepModel}
            onChange={(e) => setStepModel(e.target.value)}
            options={MODELS.map((m) => ({ value: m.value, label: m.label }))}
          />
          <div>
            <Select
              label="What it may touch"
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              options={CAPABILITIES.map((c) => ({ value: c.value, label: c.label }))}
            />
            <p className="mt-1 text-[12px] text-text-muted">
              {CAPABILITIES.find((c) => c.value === capability)?.hint}
            </p>
          </div>

          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={createStep} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
