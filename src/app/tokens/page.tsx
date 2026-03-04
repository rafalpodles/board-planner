"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { ApiApiToken } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

export default function TokensPage() {
  const api = useApi();
  const { toast } = useToast();
  const [tokens, setTokens] = useState<ApiApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .get("/api/tokens")
      .then(setTokens)
      .catch(() => toast("Failed to load tokens", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await api.post("/api/tokens", { name: name.trim() });
      setNewToken(result.token);
      setTokens((prev) => [
        { _id: result._id, name: result.name, prefix: result.prefix, lastUsedAt: null, createdAt: result.createdAt },
        ...prev,
      ]);
      setName("");
      toast("Token created", "success");
    } catch {
      toast("Failed to create token", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await api.del("/api/tokens", { id });
      setTokens((prev) => prev.filter((t) => t._id !== id));
      toast("Token revoked", "success");
    } catch {
      toast("Failed to revoke token", "error");
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">API Tokens</h1>

      <p className="text-sm text-text-muted mb-6">
        Use API tokens for programmatic access (MCP server, CI, scripts).
        Tokens use <code>Bearer</code> authentication.
      </p>

      {/* Create token */}
      <div className="bg-bg-card border border-border rounded-lg p-4 mb-6">
        <h2 className="font-semibold mb-3">Create New Token</h2>
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. MCP Server, CI)"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>

      {/* Show new token once */}
      {newToken && (
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 mb-6">
          <p className="text-sm font-medium text-warning mb-2">
            Copy your token now — it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 bg-bg text-sm px-3 py-2 rounded border border-border break-all select-all">
              {newToken}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                navigator.clipboard.writeText(newToken);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-2">
            Usage: <code>Authorization: Bearer {newToken.substring(0, 11)}...</code>
          </p>
          <button
            onClick={() => setNewToken(null)}
            className="text-xs text-text-muted hover:text-text mt-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Token list */}
      {tokens.length === 0 ? (
        <p className="text-text-muted text-center py-8">No tokens yet.</p>
      ) : (
        <div className="space-y-2">
          {tokens.map((token) => (
            <div
              key={token._id}
              className="flex items-center justify-between bg-bg-card border border-border rounded-lg px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{token.name}</p>
                <p className="text-xs text-text-muted">
                  <code>{token.prefix}...</code>
                  {" \u00b7 "}
                  Created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt && (
                    <>
                      {" \u00b7 "}
                      Last used {new Date(token.lastUsedAt).toLocaleDateString()}
                    </>
                  )}
                </p>
              </div>
              <Button
                size="sm"
                variant="danger"
                onClick={() => handleRevoke(token._id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
