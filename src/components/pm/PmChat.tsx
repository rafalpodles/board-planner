"use client";

import { useCallback, useEffect, useRef, useState, KeyboardEvent } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiPmMessage, ApiProject, ApiTask } from "@/types";
import { Button } from "@/components/ui/Button";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { timeAgo } from "@/lib/time";

const ACTION_ICONS: Record<string, string> = {
  create_task: "✚",
  update_task: "✎",
  change_status: "→",
  assign_task: "@",
  add_comment: "💬",
};

export function PmChat({
  projectId,
  preloadedProject,
  showTitle = false,
}: {
  projectId: string;
  preloadedProject?: ApiProject;
  showTitle?: boolean;
}) {
  const api = useApi();

  const [project, setProject] = useState<ApiProject | null>(preloadedProject ?? null);
  const [messages, setMessages] = useState<ApiPmMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [taskIdByKey, setTaskIdByKey] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const [workingStatus, setWorkingStatus] = useState("");
  const [liveActions, setLiveActions] = useState<{ tool: string; taskKey?: string; summary: string }[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [errorState, setErrorState] = useState("");
  const [lastFailedInput, setLastFailedInput] = useState("");
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refreshTaskMap = useCallback(async () => {
    try {
      const tasks: ApiTask[] = await api.get(`/api/projects/${projectId}/tasks`);
      const proj = project ?? (await api.get(`/api/projects/${projectId}`));
      const map: Record<string, string> = {};
      for (const t of tasks) map[`${proj.key}-${t.taskNumber}`] = t._id;
      setTaskIdByKey(map);
    } catch {
      // non-critical: chips fall back to non-links
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, project]);

  const loadMessages = useCallback(async () => {
    const data = await api.get(`/api/projects/${projectId}/pm/messages?limit=50`);
    setMessages(data.messages);
    setNextCursor(data.nextCursor);
    return data.messages as ApiPmMessage[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const projectPromise = preloadedProject
      ? Promise.resolve(preloadedProject).then(setProject)
      : api.get(`/api/projects/${projectId}`).then(setProject);
    Promise.all([projectPromise, loadMessages().catch(() => {})])
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    refreshTaskMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?._id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveActions, working]);

  // Stream lost mid-turn: poll history until the assistant message is finalized
  const recoveryPoll = useCallback(async () => {
    try {
      const msgs = await loadMessages();
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.content) {
        setRecovering(false);
        setWorking(false);
        setWorkingStatus("");
        setLiveActions([]);
        refreshTaskMap();
      }
    } catch {
      // keep polling
    }
  }, [loadMessages, refreshTaskMap]);
  usePollWhileVisible(recoveryPoll, 3000, recovering);

  async function send(text: string) {
    const message = text.trim();
    if (!message || working) return;
    setErrorState("");
    setInput("");
    setWorking(true);
    setWorkingStatus("PM myśli…");
    setLiveActions([]);

    // Optimistic user message
    setMessages((prev) => [
      ...prev,
      {
        _id: `local-${prev.length}`,
        project: projectId,
        role: "user",
        content: message,
        actions: [],
        triggeredBy: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    let response: Response;
    try {
      response = await api.stream(`/api/projects/${projectId}/pm/chat`, { message });
    } catch {
      setWorking(false);
      setErrorState("Nie udało się połączyć z serwerem.");
      setLastFailedInput(message);
      return;
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setWorking(false);
      if (response.status === 409) {
        setWorkingStatus("");
        setErrorState("PM już pracuje nad odpowiedzią w tym projekcie — poczekaj chwilę.");
        setRecovering(true);
        setWorking(true);
      } else if (response.status === 429) {
        setErrorState(err.error || "Limit tur na dziś wyczerpany.");
      } else if (response.status === 503) {
        setErrorState("PM nie jest skonfigurowany na serwerze (brak OPENROUTER_API_KEY).");
      } else {
        setErrorState(err.error || "Błąd żądania.");
        setLastFailedInput(message);
      }
      return;
    }

    try {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = chunk.match(/^event: (.+)$/m)?.[1];
          const dataLine = chunk.match(/^data: (.+)$/m)?.[1];
          if (!eventLine || !dataLine) continue;
          const data = JSON.parse(dataLine);

          if (eventLine === "action") {
            setLiveActions((prev) => [...prev, data]);
            setWorkingStatus(data.summary);
          } else if (eventLine === "done" || eventLine === "error") {
            finished = true;
            if (eventLine === "error" && data.error) {
              setErrorState(data.error);
              setLastFailedInput(message);
            }
          }
        }
      }

      if (!finished) {
        // Stream ended without done/error — recover via polling
        setRecovering(true);
        setWorkingStatus("Połączenie przerwane — odzyskuję odpowiedź…");
        return;
      }

      await loadMessages();
      refreshTaskMap();
      setWorking(false);
      setWorkingStatus("");
      setLiveActions([]);
    } catch {
      setRecovering(true);
      setWorkingStatus("Połączenie przerwane — odzyskuję odpowiedź…");
    }
  }

  async function loadOlder() {
    if (!nextCursor) return;
    const data = await api.get(
      `/api/projects/${projectId}/pm/messages?limit=50&before=${nextCursor}`
    );
    setMessages((prev) => [...data.messages, ...prev]);
    setNextCursor(data.nextCursor);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function ActionChips({ actions }: { actions: { tool: string; taskKey?: string; summary: string }[] }) {
    if (!actions.length) return null;
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        {actions.map((a, i) => {
          const taskId = a.taskKey ? taskIdByKey[a.taskKey] : undefined;
          const chip = (
            <span className="inline-flex items-center gap-1 text-xs bg-bg-input border border-border rounded-full px-2 py-0.5 text-text-muted hover:text-text transition-colors">
              <span>{ACTION_ICONS[a.tool] || "•"}</span>
              {a.summary}
            </span>
          );
          return taskId ? (
            <Link key={i} href={`/projects/${projectId}/tasks/${taskId}`}>
              {chip}
            </Link>
          ) : (
            <span key={i}>{chip}</span>
          );
        })}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!project?.pm?.enabled || !project?.pmAvailable) {
    return (
      <div className="px-4 py-10 text-center space-y-3">
        <h1 className="text-xl font-bold">PM Agent</h1>
        <p className="text-sm text-text-muted">
          {!project?.pmAvailable
            ? "PM nie jest skonfigurowany na serwerze (brak OPENROUTER_API_KEY)."
            : "PM agent jest wyłączony dla tego projektu — włącz go w ustawieniach."}
        </p>
        <Link href={`/projects/${projectId}/settings`} className="text-primary text-sm hover:underline">
          Przejdź do ustawień
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 px-3">
      {showTitle && (
        <h1 className="font-bold text-lg py-2 border-b border-border">PM — {project.name}</h1>
      )}
      <div className="flex-1 overflow-y-auto py-4 space-y-4 min-h-0">
        {nextCursor && (
          <div className="text-center">
            <button onClick={loadOlder} className="text-xs text-text-muted hover:text-text cursor-pointer">
              Load older messages
            </button>
          </div>
        )}
        {messages.length === 0 && !working && (
          <p className="text-sm text-text-muted text-center py-10">
            Porozmawiaj z PM-em: poproś o rozpisanie feature&apos;a, refinement tasków albo zapytaj o stan projektu.
          </p>
        )}
        {messages.map((m) => (
          <div key={m._id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] bg-primary/10 border border-primary/20 rounded-lg px-3 py-2"
                  : "max-w-[85%] bg-bg-card border border-border rounded-lg px-3 py-2"
              }
            >
              {m.role === "assistant" && (
                <p className="text-[11px] font-medium text-text-muted mb-1">PM Agent</p>
              )}
              <div className="text-sm prose-sm break-words">
                <MarkdownContent>{m.content || "…"}</MarkdownContent>
              </div>
              <ActionChips actions={m.actions} />
              <p className="text-[10px] text-text-muted mt-1">{timeAgo(m.createdAt)}</p>
            </div>
          </div>
        ))}
        {working && (
          <div className="flex justify-start">
            <div className="max-w-[85%] bg-bg-card border border-border rounded-lg px-3 py-2">
              <p className="text-[11px] font-medium text-text-muted mb-1">PM Agent</p>
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary border-t-transparent shrink-0" />
                {workingStatus || "PM pracuje…"}
              </div>
              <ActionChips actions={liveActions} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {errorState && (
        <div className="mb-2 text-sm text-danger flex items-center gap-3">
          <span>{errorState}</span>
          {lastFailedInput && (
            <Button size="sm" variant="secondary" onClick={() => { setErrorState(""); send(lastFailedInput); }}>
              Ponów
            </Button>
          )}
        </div>
      )}

      <div className="pb-3 pt-2 border-t border-border flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Napisz do PM-a… (Enter wysyła, Shift+Enter nowa linia)"
          rows={2}
          disabled={working}
          className="flex-1 bg-bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-60"
        />
        <Button onClick={() => send(input)} disabled={working || !input.trim()}>
          Wyślij
        </Button>
      </div>
    </div>
  );
}
