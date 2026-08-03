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
import { Modal } from "@/components/ui/Modal";
import { AuthedImage } from "@/components/ui/AuthedImage";

const MAX_ATTACHMENTS = 4;
const MAX_INPUT_HEIGHT = 200;

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
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Height is measured, not declared: `auto` first so shrinking is possible, then
  // the content height capped, past which the textarea scrolls on its own
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
        setStopping(false);
        setWorkingStatus("");
        setLiveActions([]);
        refreshTaskMap();
        emitBoardRefresh(projectId);
      }
    } catch {
      // keep polling
    }
  }, [loadMessages, refreshTaskMap]);
  usePollWhileVisible(recoveryPoll, 3000, recovering);

  async function interrupt() {
    setStopping(true);
    setWorkingStatus("Stopping…");
    try {
      await api.post(`/api/projects/${projectId}/pm/interrupt`, {});
    } catch {
      // 404 = the turn finished on its own between click and request; the stream
      // is about to deliver the real answer, so there is nothing to report
    }
  }

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;

    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) {
      setErrorState(`At most ${MAX_ATTACHMENTS} images per message.`);
      return;
    }

    setUploading(true);
    setErrorState("");
    try {
      for (const original of images.slice(0, room)) {
        const resized = await downscaleImage(original);
        const form = new FormData();
        form.append("file", resized.file);
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
    setInput("");
    setStopping(false);
    setWorking(true);
    setWorkingStatus("PM is thinking…");
    setLiveActions([]);

    const sentAttachments = pending.map(({ previewUrl: _preview, ...rest }) => rest);
    setPending([]);

    // Optimistic user message
    setMessages((prev) => [
      ...prev,
      {
        _id: `local-${prev.length}`,
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

    let response: Response;
    try {
      response = await api.stream(`/api/projects/${projectId}/pm/chat`, {
        message,
        ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
      });
    } catch {
      setWorking(false);
      setErrorState("Could not reach the server.");
      setLastFailedInput(message);
      return;
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setWorking(false);
      if (response.status === 409) {
        setWorkingStatus("");
        setErrorState("A PM turn is already running for this project — hold on.");
        setRecovering(true);
        setWorking(true);
      } else if (response.status === 429) {
        setErrorState(err.error || "Daily turn limit reached.");
      } else if (response.status === 503) {
        setErrorState("PM is not configured on the server (OPENROUTER_API_KEY missing).");
      } else {
        setErrorState(err.error || "Request failed.");
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
            emitBoardRefresh(projectId);
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
          return taskId ? (
            <Link key={i} href={taskPath(projectId, a.taskKey!)}>
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
        {/* Project settings cannot clear an instance lock, so sending someone there is a dead end */}
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
                      <AuthedImage
                        src={`/api/uploads/${a.fileId}`}
                        alt="Attached screenshot"
                        className="h-24 w-24 rounded border border-border object-cover"
                      />
                    </button>
                  ))}
                </div>
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
          {lastFailedInput && (
            <Button size="sm" variant="secondary" onClick={() => { setErrorState(""); send(lastFailedInput); }}>
              Retry
            </Button>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-2">
          {pending.map((p) => (
            <div key={p.fileId} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
        {/* Inside the field, pinned to its bottom edge: the field grows with the
            message, so a centred icon would drift away from the caret */}
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
              // How people actually attach a screenshot
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
            className="block w-full overflow-y-auto bg-bg-input border border-border rounded py-2 pl-10 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-60"
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
          <AuthedImage
            src={expandedImage}
            alt="Attached screenshot"
            className="max-h-[70vh] w-auto mx-auto"
          />
        )}
      </Modal>
    </div>
  );
}
