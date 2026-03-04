"use client";

import { useState, useEffect, FormEvent } from "react";
import Markdown from "react-markdown";
import { useApi } from "@/hooks/use-api";
import { ApiComment } from "@/types";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";

interface CommentsProps {
  projectId: string;
  taskId: string;
}

export function Comments({ projectId, taskId }: CommentsProps) {
  const [comments, setComments] = useState<ApiComment[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const api = useApi();
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
            className="bg-bg-input rounded-lg p-3 border border-border"
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
            </div>
            <div className="text-sm prose prose-invert prose-sm max-w-none">
              <Markdown>{comment.body}</Markdown>
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
    </div>
  );
}
