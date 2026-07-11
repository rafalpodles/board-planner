"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { ApiApiToken, ApiProject } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

interface OAuthConnection {
  _id: string;
  clientId: string;
  clientName: string;
  allowedProjects: string[];
  createdAt: string;
}

interface OAuthClientRow {
  _id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
  tokenCount: number;
}

export default function TokensPage() {
  const api = useApi();
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [tokens, setTokens] = useState<ApiApiToken[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [oauthClients, setOauthClients] = useState<OAuthClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([api.get("/api/tokens"), api.get("/api/projects"), api.get("/api/oauth/connections")])
      .then(([t, p, c]: [ApiApiToken[], ApiProject[], OAuthConnection[]]) => {
        setTokens(t);
        setProjects(p);
        setConnections(c);
      })
      .catch(() => toast("Failed to load tokens", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get("/api/oauth/clients")
      .then(setOauthClients)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  function toggleScope(projectId: string) {
    setScope((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  }

  function projectKeys(ids: string[]): string {
    const keys = ids
      .map((id) => projects.find((p) => p._id === id)?.key)
      .filter(Boolean);
    return keys.length > 0 ? keys.join(", ") : `${ids.length} project(s)`;
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await api.post("/api/tokens", { name: name.trim(), allowedProjects: scope });
      setNewToken(result.token);
      setTokens((prev) => [
        {
          _id: result._id,
          name: result.name,
          prefix: result.prefix,
          allowedProjects: result.allowedProjects || [],
          lastUsedAt: null,
          createdAt: result.createdAt,
        },
        ...prev,
      ]);
      setName("");
      setScope([]);
      toast("Token created", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create token", "error");
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

  async function handleRevokeConnection(id: string) {
    try {
      await api.del("/api/oauth/connections", { id });
      setConnections((prev) => prev.filter((c) => c._id !== id));
      toast("Connection revoked", "success");
    } catch {
      toast("Failed to revoke connection", "error");
    }
  }

  async function handleDeleteClient(row: OAuthClientRow) {
    if (
      row.tokenCount > 0 &&
      !window.confirm(
        `“${row.clientName || row.clientId}” has ${row.tokenCount} active connection(s). Deleting it revokes them. Continue?`
      )
    ) {
      return;
    }
    try {
      await api.del("/api/oauth/clients", { id: row._id });
      setOauthClients((prev) => prev.filter((c) => c._id !== row._id));
      setConnections((prev) => prev.filter((c) => c.clientId !== row.clientId));
      toast("Client deleted", "success");
    } catch {
      toast("Failed to delete client", "error");
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

        <div className="mt-4">
          <label className="block text-sm font-medium mb-2">Project access</label>
          {projects.length === 0 ? (
            <p className="text-sm text-text-muted">No projects available.</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {projects.map((p) => (
                <label
                  key={p._id}
                  className="flex items-center gap-2 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={scope.includes(p._id)}
                    onChange={() => toggleScope(p._id)}
                    className="rounded border-border"
                  />
                  <span>{p.name}</span>
                  <span className="text-text-muted font-mono text-xs">{p.key}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-text-muted mt-2">
            {scope.length === 0
              ? "No projects selected — token gets your full access (all projects)."
              : "Token is limited to the selected projects (read/write tasks, comments, sprints) and cannot perform admin actions."}
          </p>
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
                <p className="text-sm font-medium">
                  {token.name}
                  <span className="ml-2 text-xs font-normal text-text-muted">
                    {token.allowedProjects && token.allowedProjects.length > 0
                      ? `\u00b7 ${projectKeys(token.allowedProjects)}`
                      : "\u00b7 All projects"}
                  </span>
                </p>
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

      {/* OAuth connections */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-1">Connected apps (OAuth)</h2>
        <p className="text-sm text-text-muted mb-3">
          Remote MCP connectors you authorized. Revoke to cut off access immediately.
        </p>
        {connections.length === 0 ? (
          <p className="text-text-muted text-sm py-4">No active connections.</p>
        ) : (
          <div className="space-y-2">
            {connections.map((c) => (
              <div
                key={c._id}
                className="flex items-center justify-between bg-bg-card border border-border rounded-lg px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {c.clientName || "Unnamed app"}
                    <span className="ml-2 text-xs font-normal text-text-muted">
                      {c.allowedProjects.length > 0
                        ? `· ${projectKeys(c.allowedProjects)}`
                        : "· All projects"}
                    </span>
                  </p>
                  <p className="text-xs text-text-muted">
                    Connected {new Date(c.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" variant="danger" onClick={() => handleRevokeConnection(c._id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* OAuth clients (admin) */}
      {isAdmin && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-1">OAuth clients</h2>
          <p className="text-sm text-text-muted mb-3">
            Apps registered via Dynamic Client Registration. Deleting a client revokes all its connections.
          </p>
          {oauthClients.length === 0 ? (
            <p className="text-text-muted text-sm py-4">No registered clients.</p>
          ) : (
            <div className="space-y-2">
              {oauthClients.map((c) => (
                <div
                  key={c._id}
                  className="flex items-center justify-between bg-bg-card border border-border rounded-lg px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {c.clientName || "Unnamed client"}
                      <span className="ml-2 text-xs font-normal text-text-muted">
                        {`· ${c.tokenCount} connection(s)`}
                      </span>
                    </p>
                    <p className="text-xs text-text-muted">
                      <code>{c.clientId.substring(0, 16)}...</code>
                      {" · "}
                      Registered {new Date(c.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button size="sm" variant="danger" onClick={() => handleDeleteClient(c)}>
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
