"use client";

import { useState, useEffect, FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ApiComment, ApiReaction } from "@/types";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface CommentsProps {
  projectId: string;
  taskId: string;
}

export function Comments({ projectId, taskId }: CommentsProps) {
  const [comments, setComments] = useState<ApiComment[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();

  async function loadComments() {
    try {
      const data = await api.get(
        `/api/projects/${projectId}/tasks/${taskId}/comments`
      );
      setComments(data);
    } catch {
      toast("Failed to load comments", "error");
    }
  }

  useEffect(() => {
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setLoading(true);

    try {
      await api.post(
        `/api/projects/${projectId}/tasks/${taskId}/comments`,
        { body: body.trim() }
      );
      setBody("");
      await loadComments();
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
      toast("Comment updated", "success");
    } catch {
      toast("Failed to update comment", "error");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDelete(commentId: string) {
    setDeleteLoading(true);
    try {
      await api.del(
        `/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}`
      );
      setConfirmDeleteId(null);
      await loadComments();
      toast("Comment deleted", "success");
    } catch {
      toast("Failed to delete comment", "error");
    } finally {
      setDeleteLoading(false);
    }
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
      const username = typeof r.user === "object" ? r.user.username : r.user;
      grouped[r.emoji].users.push(typeof r.user === "object" ? r.user.fullName : "Unknown");
      if (user && username === user.username) {
        grouped[r.emoji].hasOwn = true;
      }
    }
    return grouped;
  }

  function isOwnComment(comment: ApiComment): boolean {
    if (!user || typeof comment.author !== "object") return false;
    return comment.author.username === user.username;
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleString();
  }

  return (
    <div>
      <h3 className="font-semibold mb-3">
        Comments ({comments.length})
      </h3>

      <div className="space-y-3 mb-4">
        {comments.map((comment) => (
          <div
            key={comment._id}
            className="bg-bg-input rounded-lg p-3 border border-border group"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium">
                {typeof comment.author === "object"
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
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={3}
                  autoFocus
                />
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
              <div className="text-sm prose prose-invert prose-sm max-w-none overflow-x-auto">
                <Markdown remarkPlugins={[remarkGfm]}>{comment.body}</Markdown>
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
        {comments.length === 0 && (
          <p className="text-sm text-text-muted">No comments yet</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <Button type="submit" size="sm" disabled={loading || !body.trim()}>
          {loading ? "Posting..." : "Add Comment"}
        </Button>
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
