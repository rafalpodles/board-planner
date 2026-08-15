"use client";

import { useEffect, useState, FormEvent } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { ApiUser } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

const MIN_PASSWORD_LENGTH = 8;

export default function UsersPage() {
  const { user: currentUser, isAdmin, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<ApiUser[]>([]);
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
  const [editSaving, setEditSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Delete state
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<ApiUser | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);

  const api = useApi();
  const { toast } = useToast();

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      router.replace("/projects");
      return;
    }

    api
      .get("/api/users")
      .then(setUsers)
      .catch(() => toast("Failed to load data", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, authLoading]);

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
    closePasswordField();
  }

  function closePasswordField() {
    setNewPassword("");
    setPasswordError("");
    setShowPassword(false);
  }

  function closeEdit() {
    setEditUser(null);
    closePasswordField();
  }

  async function handleEditSave() {
    if (!editUser) return;
    setPasswordError("");

    if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setEditSaving(true);
    const { username } = editUser;
    const passwordWasSet = !!newPassword;

    try {
      await api.put(`/api/users/${editUser._id}`, {
        role: editRole,
        ...(passwordWasSet ? { password: newPassword } : {}),
      });
      closeEdit();
      const data = await api.get("/api/users");
      setUsers(data);
      toast(
        passwordWasSet
          ? `Password set for ${username}. They were signed out everywhere.`
          : "User updated",
        "success"
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update user", "error");
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
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete user", "error");
    } finally {
      setDeleting(false);
    }
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
        <h2 className="text-lg font-semibold">Users</h2>
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
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
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
        onClose={closeEdit}
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

            <div className="border-t border-border pt-4">
              {currentUser?._id === editUser._id ? (
                <>
                  <p className="text-sm font-medium mb-1">Set a new password</p>
                  <p className="text-sm text-text-muted">
                    Your own password is changed under Settings → Security, where the current one is
                    required.
                  </p>
                </>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleEditSave();
                  }}
                  className="space-y-2"
                >
                  <label
                    htmlFor="newUserPassword"
                    className="block text-sm font-medium mb-1"
                  >
                    Set a new password
                  </label>
                  <p id="newUserPasswordHelp" className="text-sm text-text-muted">
                    Nothing is sent — tell {editUser.fullName} yourself. Saving signs them out
                    everywhere.
                  </p>
                  <div className="flex items-start gap-2">
                    <Input
                      id="newUserPassword"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      aria-describedby="newUserPasswordHelp"
                      minLength={MIN_PASSWORD_LENGTH}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                      error={passwordError}
                    />
                    {/* Read out over the phone more often than typed twice, so showing it beats a
                        confirm field: a typo here locks the account out of every session it had */}
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0"
                      onClick={() => setShowPassword((shown) => !shown)}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </Button>
                  </div>
                </form>
              )}
            </div>

            <p className="text-sm text-text-muted">
              Board access is granted per board, under that board&apos;s Settings → General.
            </p>

            <div className="flex gap-3 pt-2">
              <Button onClick={handleEditSave} disabled={editSaving}>
                {editSaving ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="secondary"
                onClick={closeEdit}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  closeEdit();
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
