"use client";

import { useEffect, useState, FormEvent } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { ApiUser, ApiProject } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Edit user state
  const [editUser, setEditUser] = useState<ApiUser | null>(null);
  const [editRole, setEditRole] = useState<"admin" | "member">("member");
  const [editProjects, setEditProjects] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  // Delete state
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<ApiUser | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);

  const api = useApi();
  const { toast } = useToast();

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }

    Promise.all([api.get("/api/users"), api.get("/api/projects")])
      .then(([u, p]: [ApiUser[], ApiProject[]]) => {
        setUsers(u);
        setProjects(p);
      })
      .catch(() => toast("Failed to load data", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      await api.post("/api/users", { username, password, fullName });
      setShowNew(false);
      setUsername("");
      setPassword("");
      setFullName("");
      const data = await api.get("/api/users");
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setSaving(false);
    }
  }

  function openEdit(user: ApiUser) {
    setEditUser(user);
    setEditRole(user.role || "member");
    setEditProjects(user.allowedProjects || []);
  }

  async function handleEditSave() {
    if (!editUser) return;
    setEditSaving(true);

    try {
      await api.put(`/api/users/${editUser._id}`, {
        role: editRole,
        allowedProjects: editProjects,
      });
      setEditUser(null);
      const data = await api.get("/api/users");
      setUsers(data);
      toast("User updated", "success");
    } catch {
      toast("Failed to update user", "error");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDeleteUser) return;
    setDeleting(true);
    try {
      await api.del(`/api/users/${confirmDeleteUser._id}`);
      setConfirmDeleteUser(null);
      const data = await api.get("/api/users");
      setUsers(data);
      toast("User deleted", "success");
    } catch {
      toast("Failed to delete user", "error");
    } finally {
      setDeleting(false);
    }
  }

  function toggleProject(projectId: string) {
    setEditProjects((prev) =>
      prev.includes(projectId)
        ? prev.filter((p) => p !== projectId)
        : [...prev, projectId]
    );
  }

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Users</h1>
        <Button onClick={() => setShowNew(true)}>New User</Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {users.map((u) => (
          <Card
            key={u._id}
            onClick={() => openEdit(u)}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/30 flex items-center justify-center text-sm font-medium flex-shrink-0">
                {u.fullName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">{u.fullName}</p>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      u.role === "admin"
                        ? "bg-primary/20 text-primary"
                        : "bg-bg-input text-text-muted"
                    }`}
                  >
                    {u.role === "admin" ? "Admin" : "Member"}
                  </span>
                </div>
                <p className="text-sm text-text-muted truncate">
                  @{u.username}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Create User Modal */}
      <Modal
        open={showNew}
        onClose={() => setShowNew(false)}
        title="New User"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Input
            label="Full Name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Creating..." : "Create User"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowNew(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={editUser ? `Edit ${editUser.fullName}` : ""}
      >
        {editUser && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditRole("admin")}
                  className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                    editRole === "admin"
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-border text-text-muted hover:border-text"
                  }`}
                >
                  Admin
                </button>
                <button
                  type="button"
                  onClick={() => setEditRole("member")}
                  className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                    editRole === "member"
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-border text-text-muted hover:border-text"
                  }`}
                >
                  Member
                </button>
              </div>
            </div>

            {editRole === "member" && (
              <div>
                <label className="block text-sm font-medium mb-2">
                  Project Access
                </label>
                {projects.length === 0 ? (
                  <p className="text-sm text-text-muted">No projects</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {projects.map((p) => (
                      <label
                        key={p._id}
                        className="flex items-center gap-2 cursor-pointer text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={editProjects.includes(p._id)}
                          onChange={() => toggleProject(p._id)}
                          className="rounded border-border"
                        />
                        <span>{p.name}</span>
                        <span className="text-text-muted font-mono text-xs">
                          {p.key}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-text-muted mt-2">
                  Members can only see and work on checked projects. Admins see
                  all.
                </p>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button onClick={handleEditSave} disabled={editSaving}>
                {editSaving ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setEditUser(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setEditUser(null);
                  setConfirmDeleteUser(editUser);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDeleteUser}
        onClose={() => setConfirmDeleteUser(null)}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete "${confirmDeleteUser?.fullName}"? This action cannot be undone.`}
        confirmLabel="Delete User"
        loading={deleting}
      />
    </div>
  );
}
