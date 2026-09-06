"use client";

import { useState, useEffect, useRef, useCallback, useMemo, FormEvent, KeyboardEvent } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ApiComment, ApiReaction } from "@/types";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { Avatar } from "@/components/tasks/detail/atoms";
import type { ReferenceScope } from "@/lib/task-references";
import { useTriggerAutocomplete, type Trigger } from "@/hooks/use-trigger-autocomplete";
import { SuggestionList } from "@/components/ui/SuggestionList";
import { useEditorTriggers } from "@/hooks/use-editor-triggers";

interface CommentsProps {
  projectId: string;
  taskId: string;
  hideHeading?: boolean;
  onCountChange?: (count: number | null) => void;
  /** Bumped when a comment is posted from somewhere else, e.g. the phone's bottom bar */
  refreshKey?: number;
  // Adding, editing and deleting a comment each write an activity entry; reacting does not
  onMutated?: () => void;
  /** The board these comments belong to, so a written task key becomes a link to that task */
  scope?: ReferenceScope | null;
}

export function Comments({
  projectId,
  taskId,
  hideHeading,
  onCountChange,
  onMutated,
  refreshKey = 0,
  scope,
}: CommentsProps) {
  const [comments, setComments] = useState<ApiComment[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reading, setReading] = useState(true);
  const loadSeq = useRef(0);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();

  async function loadComments() {
    // A task switch reconciles this panel in place, so the previous task's read is still in
    // flight and would otherwise land as this task's discussion
    const seq = ++loadSeq.current;
    try {
      const data = await api.get(
        `/api/projects/${projectId}/tasks/${taskId}/comments`
      );
      if (seq !== loadSeq.current) return;
      setComments(data);
      setLoadFailed(false);
      onCountChange?.(data.length);
    } catch {
      // "No comments yet" is a claim about the discussion on this task, and a read that never
      // answered supports none. The toast clears after three seconds; the sentence would not.
      if (seq !== loadSeq.current) return;
      setLoadFailed(true);
      toast("Failed to load comments", "error");
    } finally {
      if (seq === loadSeq.current) setReading(false);
    }
  }

  useEffect(() => {
    // A task switch reconciles this component in place, so without the reset the previous task's
    // comments stand in as this one's until the read lands — and stay if it fails
    setReading(true);
    setLoadFailed(false);
    setComments([]);
    // The count belongs to the task that was here a moment ago; nobody knows this one's yet
    onCountChange?.(null);
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (refreshKey === 0) return;
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    postComment();
  }

  async function postComment() {
    if (!body.trim()) return;
    setLoading(true);

    try {
      await api.post(
        `/api/projects/${projectId}/tasks/${taskId}/comments`,
        { body: body.trim() }
      );
      setBody("");
      await loadComments();
      onMutated?.();
    } catch {
      toast("Failed to post comment", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleEdit(commentId: string) {
    if (!editBody.trim()) return;
    setEditLoading(true);
    try {
      await api.put(
        `/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
        { body: editBody.trim() }
      );
      setEditingId(null);
      setEditBody("");
      await loadComments();
      onMutated?.();
      toast("Comment updated", "success");
    } catch {
      toast("Failed to update comment", "error");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(commentId: string) {
    if (deleteLoading) return;
    setDeleteLoading(true);
    // The flag reaches ConfirmDialog as `loading`, which now refuses the dialog's own ways out, so
    // it has to end with the DELETE rather than with the reload that follows it: held across the
    // reload it belonged to a dialog that had closed, and the next one opened unable to close
    // (BP-565).
    try {
      await api.del(
        `/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}`
      );
    } catch {
      toast("Failed to delete comment", "error");
      setDeleteLoading(false);
      return;
    }
    setDeleteLoading(false);
    setConfirmDeleteId(null);
    await loadComments();
    onMutated?.();
    toast("Comment deleted", "success");
  }

  const REACTION_EMOJIS = ["\u{1F44D}", "\u{1F44E}", "\u{2764}\uFE0F", "\u{1F440}", "\u{1F389}", "\u{1F604}"];

  async function toggleReaction(commentId: string, emoji: string) {
    try {
      await api.patch(
        `/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
        { emoji }
      );
      await loadComments();
    } catch {
      toast("Failed to react", "error");
    }
  }

  function groupReactions(reactions: ApiReaction[]) {
    const grouped: Record<string, { count: number; users: string[]; hasOwn: boolean }> = {};
    for (const r of reactions) {
      if (!grouped[r.emoji]) {
        grouped[r.emoji] = { count: 0, users: [], hasOwn: false };
      }
      grouped[r.emoji].count++;
      const populated = r.user && typeof r.user === "object" ? r.user : null;
      const username = populated ? populated.username : r.user;
      grouped[r.emoji].users.push(populated ? populated.fullName : "Unknown");
      if (user && username === user.username) {
        grouped[r.emoji].hasOwn = true;
      }
    }
    return grouped;
  }

  function isOwnComment(comment: ApiComment): boolean {
    if (!user || !comment.author || typeof comment.author !== "object") return false;
    return comment.author.username === user.username;
  }

  // Two instances, one per composer: each owns a textarea, and the edit box used to share the new
  // comment's state through a "target" flag threaded into every handler.
  const triggers = useEditorTriggers(projectId, scope?.key);
  const newMention = useTriggerAutocomplete(triggers, textareaRef, setBody);
  const editMention = useTriggerAutocomplete(triggers, editTextareaRef, setEditBody);

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleString();
  }

  return (
    <div>
      {!hideHeading && (
        <h3 className="font-semibold mb-3">
          Comments ({comments.length})
        </h3>
      )}

      <div className="space-y-3 mb-4">
        {comments.map((comment) => (
          <div
            key={comment._id}
            className="bg-bg-input rounded-lg p-3 border border-border group"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium">
                {comment.author && typeof comment.author === "object"
                  ? comment.author.fullName
                  : "Unknown"}
              </span>
              <span className="text-xs text-text-muted">
                {formatDate(comment.createdAt)}
              </span>
              {comment.updatedAt !== comment.createdAt && (
                <span className="text-xs text-text-muted italic">
                  (edited)
                </span>
              )}
              {isOwnComment(comment) && editingId !== comment._id && (
                <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => {
                      setEditingId(comment._id);
                      setEditBody(comment.body);
                    }}
                    className="text-xs text-text-muted hover:text-text"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(comment._id)}
                    className="text-xs text-text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {editingId === comment._id ? (
              <div className="space-y-2">
                <div className="relative">
                  <SuggestionList
                    items={editMention.items}
                    index={editMention.index}
                    onPick={editMention.choose}
                    onHover={editMention.setIndex}
                  />
                  <textarea
                    ref={editTextareaRef}
                    value={editBody}
                    onChange={(e) => {
                      setEditBody(e.target.value);
                      editMention.detect(e.target.value, e.target.selectionStart);
                    }}
                    onKeyDown={editMention.onKeyDown}
                    onBlur={() => setTimeout(editMention.close, 150)}
                    rows={3}
                    autoFocus
                    className="focus-ring w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-text min-h-[88px] placeholder:text-text-muted resize-y"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleEdit(comment._id)}
                    disabled={editLoading || !editBody.trim()}
                  >
                    {editLoading ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditingId(null);
                      setEditBody("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm prose prose-sm max-w-none overflow-x-auto">
                <MarkdownContent mentions scope={scope}>{comment.body}</MarkdownContent>
              </div>
            )}

            {/* Reactions */}
            <div className="flex items-center gap-1 mt-2 flex-wrap">
              {Object.entries(groupReactions(comment.reactions || [])).map(
                ([emoji, { count, users, hasOwn }]) => (
                  <button
                    key={emoji}
                    onClick={() => toggleReaction(comment._id, emoji)}
                    title={users.join(", ")}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${
                      hasOwn
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-bg hover:border-primary/50"
                    }`}
                  >
                    <span>{emoji}</span>
                    <span>{count}</span>
                  </button>
                )
              )}
              <div className="relative group/react">
                <button className="text-text-muted hover:text-text text-xs px-1.5 py-0.5 rounded-full border border-transparent hover:border-border transition-colors cursor-pointer">
                  +
                </button>
                <div className="absolute left-0 bottom-full mb-1 hidden group-hover/react:flex bg-bg-card border border-border rounded-lg shadow-lg p-1 gap-0.5 z-10">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => toggleReaction(comment._id, emoji)}
                      className="hover:bg-bg-hover rounded p-1 text-sm cursor-pointer"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
        {/* Three states, not one: a read still running is not an empty discussion. It holds the
            same one line the sentence takes rather than a spinner — this panel sits in a page whose
            sticky header depends on the body being the only thing that scrolls, and anything that
            resizes or animates here moves that page under the reader */}
        {reading ? (
          <p className="text-sm text-text-muted" aria-hidden>
            &nbsp;
          </p>
        ) : loadFailed ? (
          <LoadFailed
            testId="comments-error"
            variant={comments.length ? "row" : "block"}
            className={comments.length ? "mt-2" : "py-4"}
            message="Failed to load the comments."
            onRetry={() => {
              setReading(true);
              return loadComments();
            }}
          />
        ) : (
          comments.length === 0 && (
            <p className="text-sm text-text-muted">No comments yet</p>
          )
        )}
      </div>

      {/* Wide screens only: a phone comments through the bar pinned to the bottom of
          the task, so a second composer here would be a decoy */}
      <form onSubmit={handleSubmit} className="hidden items-start gap-3 pt-3 lg:flex">
        <Avatar name={user?.fullName} size={28} className="mt-1 hidden sm:inline-flex" />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="relative">
            <SuggestionList
              items={newMention.items}
              index={newMention.index}
              onPick={newMention.choose}
              onHover={newMention.setIndex}
            />
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                newMention.detect(e.target.value, e.target.selectionStart);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  postComment();
                  return;
                }
                newMention.onKeyDown(e);
              }}
              onBlur={() => setTimeout(newMention.close, 150)}
              placeholder="Write a comment, @mention someone…"
              rows={2}
              className="focus-ring min-h-[44px] w-full resize-y rounded-xl border border-border bg-bg-input px-3 py-2.5 text-text placeholder:text-text-muted"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={loading || !body.trim()}>
              {loading ? "Posting..." : "Comment"}
            </Button>
            <span className="text-xs text-text-muted">⌘↵ to send</span>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        title="Delete Comment"
        message="Are you sure you want to delete this comment?"
        confirmLabel="Delete"
        loading={deleteLoading}
      />
    </div>
  );
}
