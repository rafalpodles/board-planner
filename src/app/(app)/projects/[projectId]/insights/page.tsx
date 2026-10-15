"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useEntitlement } from "@/hooks/use-entitlement";
import { boardRefusal } from "@/lib/board-load-failure";
import { columnIdsWithRole } from "@/lib/columns";
import type { Insights } from "@/lib/insights";
import type { Dora } from "@/lib/dora";
import { ApiProject, ApiSprint } from "@/types";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { ProUpsell } from "@/components/ui/ProUpsell";
import { NotFoundExperience } from "@/components/not-found/NotFoundExperience";
import {
  AgingList,
  DeploymentsPanel,
  MEASURE_LABELS,
  Measure,
  SampleContext,
  ScatterChart,
  StatTiles,
  ThroughputChart,
  TrendChart,
} from "@/components/insights/InsightsCharts";
import { sampleInsights } from "@/components/insights/sample";

const WINDOWS = ["4", "8", "12"];
const SAMPLE_KEY = "DEMO";

function tasks(count: number): string {
  return count === 1 ? "1 task was" : `${count} tasks were`;
}

interface InsightsResponse extends Insights {
  dora: Dora | null;
  sprint: { id: string; name: string } | null;
  category: string | null;
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

export default function InsightsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const api = useApi();
  const entitlement = useEntitlement("reports.insights");

  const [project, setProject] = useState<ApiProject | null>(null);
  const [sprints, setSprints] = useState<ApiSprint[]>([]);
  const [refused, setRefused] = useState(false);
  const [scope, setScope] = useState("12");
  const [category, setCategory] = useState("");
  const [measure, setMeasure] = useState<Measure>("cycleTime");
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const [planRefused, setPlanRefused] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.get(`/api/projects/${projectId}`), api.get(`/api/projects/${projectId}/sprints`)]).then(
      ([p, s]) => {
        if (cancelled) return;
        if (p.status === "fulfilled") setProject(p.value);
        else setRefused(boardRefusal(p.reason) !== null);
        setSprints(s.status === "fulfilled" ? s.value : []);
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const load = useCallback(() => {
    if (!entitlement.entitled || planRefused) return;
    const mine = (generation.current += 1);
    const query = new URLSearchParams(WINDOWS.includes(scope) ? { weeks: scope } : { sprint: scope });
    if (category) query.set("category", category);
    setLoading(true);
    setFailure("");
    api
      .get(`/api/projects/${projectId}/insights?${query}`)
      .then((answer: InsightsResponse) => {
        if (mine === generation.current) setData(answer);
      })
      .catch((reason: unknown) => {
        if (mine !== generation.current) return;
        setData(null);
        if ((reason as { status?: number } | null)?.status === 402) {
          setPlanRefused(true);
          return;
        }
        const message = (reason as { message?: string } | null)?.message;
        setFailure(message ? `Insights could not be loaded: ${message}` : "Insights could not be loaded.");
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, entitlement.entitled, planRefused, scope, category]);

  useEffect(load, [load]);

  const sample = useMemo(() => sampleInsights(Date.now()), []);
  const projectRef = project?.key ?? projectId;
  const noDoneColumn = project ? columnIdsWithRole(project, "done").length === 0 : false;

  if (refused) return <div data-testid="insights-not-found"><NotFoundExperience /></div>;

  const header = <PageHeader title="Insights" subtitle={project?.name ?? ""} />;

  if (entitlement.loading) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        {header}
        <Spinner />
      </div>
    );
  }

  if (entitlement.error) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        {header}
        <div data-testid="insights-error" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-6 text-center text-sm">
          The plan could not be read, so Insights cannot be shown.
        </div>
      </div>
    );
  }

  const onSample = !entitlement.entitled || planRefused;
  const shown = onSample ? sample : data;

  const scopeOptions = [
    ...WINDOWS.map((w) => ({ value: w, label: `Last ${w} weeks` })),
    ...sprints.map((s) => ({ value: s._id, label: `Sprint: ${s.name}` })),
  ];
  const categoryOptions = (project?.categories ?? []).map((c) => ({ value: c.name, label: c.name }));

  return (
    <div className="mx-auto w-full max-w-7xl">
      {header}

      {onSample && (
        <div className="mb-6" data-testid="insights-upsell">
          <ProUpsell title="Insights">
            Cycle time, lead time, throughput and ageing work for this board are part of Board Planner Pro. Below is
            sample data, not this board&apos;s.
          </ProUpsell>
        </div>
      )}

      {!onSample && (
        <div className="mb-6 flex flex-wrap items-end gap-3" data-testid="insights-filters">
          <div className="w-full sm:w-56">
            <Select label="Window" value={scope} onChange={(e) => setScope(e.target.value)} options={scopeOptions} />
          </div>
          <div className="w-full sm:w-48">
            <Select
              label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={categoryOptions}
              placeholder="All categories"
            />
          </div>
          <div className="w-full sm:w-44">
            <Select
              label="Time shown"
              value={measure}
              onChange={(e) => setMeasure(e.target.value as Measure)}
              options={(Object.keys(MEASURE_LABELS) as Measure[]).map((m) => ({ value: m, label: MEASURE_LABELS[m] }))}
            />
          </div>
        </div>
      )}

      {noDoneColumn && !onSample && (
        <div data-testid="insights-no-done-column" className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          This board has no column meaning Done, so no task can count as finished. Give a column that role in Settings → Board.
        </div>
      )}

      {failure && !loading && (
        <div data-testid="insights-error" className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-6 text-center">
          <p className="text-sm">{failure}</p>
          <Button variant="secondary" className="mt-4" onClick={load}>
            Try again
          </Button>
        </div>
      )}

      {!shown && loading && <Spinner />}

      {shown && (
        <SampleContext.Provider value={onSample}>
          <div data-testid={onSample ? "insights-sample" : "insights-live"} aria-busy={loading}>
            {!onSample && shown.empty && !noDoneColumn && (
              <p data-testid="insights-empty" className="mb-4 text-sm text-text-muted">
                No task finished in this window yet. Times appear once a task goes from In Progress to Done.
              </p>
            )}
            {!onSample && shown.excluded.startInferred > 0 && (
            <p data-testid="insights-start-inferred" className="mb-4 text-sm text-text-muted">
              {tasks(shown.excluded.startInferred)} created straight into In Progress, so there is no start to measure
              cycle time or age from.
            </p>
          )}
          {!onSample && shown.excluded.noHistory + shown.excluded.gap > 0 && (
              <p data-testid="insights-excluded" className="mb-4 text-sm text-text-muted">
                {tasks(shown.excluded.noHistory + shown.excluded.gap)} left out because the history of moves is incomplete.
              </p>
            )}
            <StatTiles insights={shown} noDoneColumn={noDoneColumn && !onSample} />
            <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <TrendChart insights={shown} measure={measure} />
              <ScatterChart insights={shown} measure={measure} projectRef={onSample ? SAMPLE_KEY : projectRef} />
              <ThroughputChart insights={shown} noDoneColumn={noDoneColumn && !onSample} />
              <AgingList insights={shown} projectRef={onSample ? SAMPLE_KEY : projectRef} linkTasks={!onSample} />
              <DeploymentsPanel dora={shown.dora} />
            </div>
          </div>
        </SampleContext.Provider>
      )}
    </div>
  );
}
