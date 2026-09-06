"use client";

import { useCallback, useEffect, useRef, useState, KeyboardEvent } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { emitBoardRefresh } from "@/lib/board-refresh";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { ApiPmMessage, ApiProject, ApiTask } from "@/types";
import { Button } from "@/components/ui/Button";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { timeAgo } from "@/lib/time";
import { downscaleImage, estimateImageTokens } from "@/lib/image-resize";
import { isPmLockedByInstance, isPmRunnable, pmDisabledReason } from "@/lib/pm/gate";
import { taskPath } from "@/lib/urls";
import { useOpenTask } from "@/hooks/use-open-task";
import { Modal } from "@/components/ui/Modal";

const MAX_ATTACHMENTS = 4;
const MAX_INPUT_HEIGHT = 200;

const RECOVERY_INTERVAL_MS = 3000;
const RECOVERY_BLOCK_MS = 30_000;
const RECOVERY_WINDOW_MS = 300_000;

interface PendingAttachment {
  fileId: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  previewUrl: string;
}

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
  const openTask = useOpenTask();
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const [workingStatus, setWorkingStatus] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [liveActions, setLiveActions] = useState<{ tool: string; taskKey?: string; summary: string }[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [errorState, setErrorState] = useState("");
  const [lastFailedInput, setLastFailedInput] = useState("");
  const [retryable, setRetryable] = useState(false);
  const optimisticSeq = useRef(0);
  const recoveryStartedAt = useRef(0);
  const answerBefore = useRef("");
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [input]);

  const refreshTaskMap = useCallback(async () => {
    try {
      const tasks: ApiTask[] = await api.get(`/api/projects/${projectId}/tasks`);
      const proj = project ?? (await api.get(`/api/projects/${projectId}`));
      const map: Record<string, string> = {};
      for (const t of tasks) map[`${proj.key}-${t.taskNumber}`] = t._id;
      setTaskIdByKey(map);
    } catch {
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

  const recoveryPoll = useCallback(async () => {
    const elapsed = Date.now() - recoveryStartedAt.current;
    try {
      const msgs = await loadMessages();
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.content && last._id !== answerBefore.current) {
        setRecovering(false);
        setWorking(false);
        setStopping(false);
        setWorkingStatus("");
        setLiveActions([]);
        refreshTaskMap();
        emitBoardRefresh(projectId);
        return;
      }
    } catch {
    }
    if (elapsed >= RECOVERY_WINDOW_MS) {
      setRecovering(false);
      setWorking(false);
      setStopping(false);
      setWorkingStatus("");
      setErrorState("Lost the connection and could not recover the answer.");
      return;
    }
    if (elapsed >= RECOVERY_BLOCK_MS) {
      setWorking(false);
      setStopping(false);
      setWorkingStatus("");
      setErrorState(
        "The connection dropped. The turn may still be running — the answer will appear here if it lands."
      );
    }
  }, [loadMessages, refreshTaskMap]);
  useEffect(() => {
    if (recovering) recoveryStartedAt.current = Date.now();
  }, [recovering]);
  usePollWhileVisible(recoveryPoll, RECOVERY_INTERVAL_MS, recovering);

  async function interrupt() {
    setStopping(true);
    setWorkingStatus("Stopping…");
    try {
      await api.post(`/api/projects/${projectId}/pm/interrupt`, {});
    } catch (error) {
      const { status, body } = error as { status?: number; body?: { error?: string } };
      const finishedOnItsOwn =
        status === 404 && body?.error === "No PM turn is running for this project";
      if (finishedOnItsOwn) return;
      setStopping(false);
      setWorkingStatus("");
      setErrorState(
        status === undefined
          ? "Could not reach the server to stop the turn."
          : (error as Error).message || "Could not stop the turn."
      );
    }
  }

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setRetryable(false);
    if (uploading) {
      setErrorState("Still attaching — try that again in a moment.");
      return;
    }

    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) {
      setErrorState(
        `Attached 0 of ${images.length} — ${MAX_ATTACHMENTS} images per message, and ${pending.length} already attached.`
      );
      return;
    }

    const taking = images.slice(0, room);
    setUploading(true);
    setErrorState(
      taking.length < images.length
        ? `Attached ${taking.length} of ${images.length} — ${MAX_ATTACHMENTS} images per message${
            pending.length ? `, and ${pending.length} already attached` : ""
          }.`
        : ""
    );
    try {
      for (const original of taking) {
        const resized = await downscaleImage(original);
        const form = new FormData();
        form.append("file", resized.file);
        form.append("projectId", projectId);
        const res = await api.upload("/api/uploads", form);
        setPending((prev) => [
          ...prev,
          {
            fileId: res.fileId,
            mimeType: resized.file.type,
            width: resized.width,
            height: resized.height,
            bytes: resized.file.size,
            previewUrl: URL.createObjectURL(resized.file),
          },
        ]);
      }
    } catch (err) {
      setErrorState(err instanceof Error ? err.message : "Could not attach that image.");
    } finally {
      setUploading(false);
    }
  }

  function removePending(fileId: string) {
    setPending((prev) => {
      const gone = prev.find((p) => p.fileId === fileId);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.fileId !== fileId);
    });
  }

  async function send(text: string) {
    const message = text.trim();
    if ((!message && pending.length === 0) || working || uploading) return;
    setErrorState("");
    setLastFailedInput("");
    setRetryable(false);
    answerBefore.current =
      [...messages].reverse().find((m) => m.role === "assistant")?._id ?? "";
    setInput("");
    setStopping(false);
    setWorking(true);
    setWorkingStatus("PM is thinking…");
    setLiveActions([]);

    const sentPending = pending;
    const sentAttachments = pending.map(({ previewUrl: _preview, ...rest }) => rest);
    setPending([]);

    const optimisticId = `local-${optimisticSeq.current++}`;
    setMessages((prev) => [
      ...prev,
      {
        _id: optimisticId,
        project: projectId,
        role: "user",
        content: message,
        actions: [],
        attachments: sentAttachments,
        trigger: { type: "chat" },
        triggeredBy: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    function unsend(reason: string, worthRetrying: boolean) {
      setWorking(false);
      setWorkingStatus("");
      setMessages((prev) => prev.filter((m) => m._id !== optimisticId));
      setInput(message);
      setPending((now) => [...sentPending, ...now].slice(0, MAX_ATTACHMENTS));
      setErrorState(reason);
      setLastFailedInput(message);
      setRetryable(worthRetrying);
    }

    let response: Response;
    try {
      response = await api.stream(`/api/projects/${projectId}/pm/chat`, {
        message,
        ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
      });
    } catch {
      unsend("Could not reach the server.", true);
      return;
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (response.status === 503) {
        unsend("PM is not configured on the server (OPENROUTER_API_KEY missing).", false);
      } else {
        unsend(err.error || "Request failed.", response.status !== 400);
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
            emitBoardRefresh(projectId);
          } else if (eventLine === "done" || eventLine === "error") {
            finished = true;
            if (eventLine === "error" && data.error) {
              setErrorState(data.error);
              setLastFailedInput(message);
              setRetryable(message.length > 0 && sentAttachments.length === 0);
            }
          }
        }
      }

      if (!finished) {
        setRecovering(true);
        setWorkingStatus("Connection lost — recovering the answer…");
        return;
      }

      await loadMessages();
      refreshTaskMap();
      emitBoardRefresh(projectId);
      setWorking(false);
      setStopping(false);
      setWorkingStatus("");
      setLiveActions([]);
    } catch {
      setRecovering(true);
      setWorkingStatus("Connection lost — recovering the answer…");
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
          const href = taskPath(projectId, a.taskKey!);
          return taskId ? (
            <Link
              key={i}
              href={href}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                openTask(href);
              }}
            >
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

  if (!project?.pmAvailable || !isPmRunnable(project?.pm)) {
    const locked = isPmLockedByInstance(project?.pm);
    return (
      <div className="px-4 py-10 text-center space-y-3">
        <h1 className="text-xl font-bold">PM Agent</h1>
        <p className="text-sm text-text-muted">
          {!project?.pmAvailable
            ? "PM is not configured on the server (OPENROUTER_API_KEY missing)."
            : locked
              ? `${pmDisabledReason(project?.pm)} — it cannot be re-enabled from project settings.`
              : "The PM agent is disabled for this project — enable it in settings."}
        </p>
        {!locked && (
          <Link href={`/projects/${projectId}/settings`} className="text-primary text-sm hover:underline">
            Go to settings
          </Link>
        )}
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
            Talk to the PM: ask it to break a feature into tasks, refine a backlog or report on project state.
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
              {m.trigger && m.trigger.type !== "chat" && (
                <span className="inline-flex items-center text-[10px] text-text-muted bg-bg-input rounded-full px-2 py-0.5 mb-1">
                  {m.trigger.type === "daily_review"
                    ? "Scheduled review"
                    : `Auto review: ${m.trigger.taskKey}`}
                </span>
              )}
              {m.attachments && m.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {m.attachments.map((a) => (
                    <button
                      key={a.fileId}
                      onClick={() => setExpandedImage(`/api/uploads/${a.fileId}`)}
                      aria-label="Expand image"
                      className="cursor-pointer"
                    >
                      <img
                        src={`/api/uploads/${a.fileId}`}
                        alt="Attached screenshot"
                        className="h-24 w-24 rounded border border-border object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
              <div className="text-sm prose-sm break-words">
                <MarkdownContent>{m.content || (m.attachments?.length ? "" : "…")}</MarkdownContent>
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
                {workingStatus || "PM is working…"}
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
          {retryable && (lastFailedInput || pending.length > 0) && (
            <Button size="sm" variant="secondary" onClick={() => { setErrorState(""); setRetryable(false); send(lastFailedInput); }}>
              Retry
            </Button>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-2">
          {pending.map((p) => (
            <div key={p.fileId} className="relative">
              <img
                src={p.previewUrl}
                alt="Attachment preview"
                className="h-16 w-16 rounded border border-border object-cover"
              />
              <button
                onClick={() => removePending(p.fileId)}
                aria-label="Remove attachment"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full
                  border border-border bg-bg-card text-xs text-text-muted hover:text-danger cursor-pointer"
              >
                ✕
              </button>
              <span className="mt-0.5 block text-center text-[10px] text-text-muted">
                ~{estimateImageTokens(p.width, p.height).toLocaleString()} tok
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        className={`pb-3 pt-2 border-t flex gap-2 items-end ${
          dragOver ? "border-primary" : "border-border"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <div className="relative flex-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={working || uploading || pending.length >= MAX_ATTACHMENTS}
            title="Attach an image"
            aria-label="Attach an image"
            className="focus-ring absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded
              text-text-muted hover:bg-bg-hover hover:text-text transition-colors cursor-pointer
              disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent
              after:absolute after:-inset-2 after:content-['']"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
              />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            placeholder={
              uploading
                ? "Attaching image…"
                : "Message the PM… (Enter sends, Shift+Enter for a new line, paste to attach)"
            }
            rows={2}
            disabled={working}
            style={{ maxHeight: MAX_INPUT_HEIGHT }}
            className="focus-ring block w-full overflow-y-auto bg-bg-input border border-border rounded py-2 pl-10 pr-3 text-sm resize-none disabled:opacity-60"
          />
        </div>
        {working ? (
          <button
            onClick={interrupt}
            disabled={stopping}
            title={stopping ? "Stopping the PM turn…" : "Stop the PM turn"}
            aria-label="Stop the PM turn"
            className="h-9 w-9 shrink-0 flex items-center justify-center rounded border border-border
              bg-bg-input text-text-muted hover:text-danger hover:border-danger/50 transition-colors
              cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ) : (
          <Button
            onClick={() => send(input)}
            disabled={uploading || (!input.trim() && pending.length === 0)}
          >
            Send
          </Button>
        )}
      </div>

      <Modal
        open={!!expandedImage}
        onClose={() => setExpandedImage(null)}
        title="Attachment"
      >
        {expandedImage && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={expandedImage}
            alt="Attached screenshot"
            className="max-h-[70vh] w-auto mx-auto"
          />
        )}
      </Modal>
    </div>
  );
}
