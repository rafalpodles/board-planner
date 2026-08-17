"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { useProjects } from "@/hooks/use-projects";
import { useAuth } from "@/hooks/use-auth";
import { useStore } from "./store";
import { AgentList, BlockList, Section } from "./components/lists";
import {
  EditBlockDialog,
  NewAgentDialog,
  NewGateDialog,
  NewStepDialog,
} from "./components/dialogs";
import { ApiAgentBlock } from "@/types";

type Tab = "agents" | "gates" | "steps";

const TABS: { id: Tab; label: string; action: string }[] = [
  { id: "agents", label: "Agents", action: "New agent" },
  { id: "gates", label: "Gates", action: "New gate" },
  { id: "steps", label: "Steps", action: "New step" },
];

export default function AgentsPage() {
  const { projects } = useProjects();
  const { isAdmin } = useAuth();
  const store = useStore();

  const [tab, setTab] = useState<Tab>("agents");
  const [dialog, setDialog] = useState<Tab | null>(null);
  const [editing, setEditing] = useState<ApiAgentBlock | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    agents: null,
    gates: null,
    steps: null,
  });

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  // A step block's prompt is what runs on somebody's machine, so authoring one is instance-admin
  // (BP-345). Composing an agent out of blocks that already exist is open to everyone, so the
  // action is only withheld on the two tabs where it would 403.
  const mayAct = tab === "agents" || isAdmin;

  // role="tablist" promises arrow-key navigation to assistive tech, so it has to work
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

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Ways of getting a task done"
        actions={
          mayAct ? (
            <Button size="sm" onClick={() => setDialog(tab)}>
              {current.action}
            </Button>
          ) : (
            <p className="text-[13px] text-text-muted">
              An instance admin authors {tab}
            </p>
          )
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

      <div
        role="tabpanel"
        id="catalog-agents"
        aria-labelledby="catalog-tab-agents"
        hidden={tab !== "agents"}
      >
        <Section title="Mine" hint="Agents you created. Only you can pick them.">
          <AgentList
            rows={store.allAgents.filter((a) => a.scope === "user")}
            empty="You have not created an agent yet."
            onDelete={store.removeAgent}
          />
        </Section>
        <Section
          title="Per project"
          hint="Created by a project owner, and usable only on that project."
        >
          <AgentList
            rows={store.allAgents.filter((a) => a.scope === "project")}
            empty="No project has its own agent."
            onDelete={store.removeAgent}
          />
        </Section>
        <Section title="Global" hint="Ship with Board Planner. Available on every project.">
          <AgentList rows={store.allAgents.filter((a) => a.scope === "global")} empty="None." />
        </Section>
      </div>

      <div
        role="tabpanel"
        id="catalog-gates"
        aria-labelledby="catalog-tab-gates"
        hidden={tab !== "gates"}
      >
        <Section
          title="Gates"
          hint="Checks that can stop a change. A gate never edits anything — it only says yes or no."
        >
          <BlockList rows={store.allGates} onDelete={store.removeBlock} onEdit={setEditing} />
        </Section>
      </div>

      <div
        role="tabpanel"
        id="catalog-steps"
        aria-labelledby="catalog-tab-steps"
        hidden={tab !== "steps"}
      >
        <Section
          title="Steps"
          hint="Work an agent does. Each step is its own session, with a fresh head."
        >
          <BlockList rows={store.allSteps} onDelete={store.removeBlock} onEdit={setEditing} />
        </Section>
      </div>

      <EditBlockDialog
        block={editing}
        onClose={() => setEditing(null)}
        onSave={store.updateBlock}
      />
      <NewAgentDialog
        open={dialog === "agents"}
        projects={projects}
        onClose={() => setDialog(null)}
        onCreate={store.addAgent}
      />
      <NewGateDialog
        open={dialog === "gates"}
        onClose={() => setDialog(null)}
        onCreate={store.addBlock}
      />
      <NewStepDialog
        open={dialog === "steps"}
        onClose={() => setDialog(null)}
        onCreate={store.addBlock}
      />
    </>
  );
}
