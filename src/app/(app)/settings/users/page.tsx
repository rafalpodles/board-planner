"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { ApiInvitation, ApiUser } from "@/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { AddToBoardModal } from "@/components/settings/AddToBoardModal";
import { InviteModal } from "@/components/settings/InviteModal";
import { usePasswordSignIn } from "@/hooks/use-password-sign-in";
import { PendingInvitations } from "@/components/settings/PendingInvitations";
import { SignUpDomains } from "@/components/settings/SignUpDomains";
import { generatePassword } from "@/lib/password-generator";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { timeAgo } from "@/lib/time";

const MIN_PASSWORD_LENGTH = 8;

type StatusFilter = "all" | "active" | "invited" | "deactivated";

const STATUS_FILTERS: [StatusFilter, string][] = [
  ["all", "All"],
  ["active", "Active"],
  ["invited", "Invited"],
  ["deactivated", "Deactivated"],
];

export default function UsersPage() {
  const { user: currentUser, isAdmin, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Edit user state
  const [editUser, setEditUser] = useState<ApiUser | null>(null);
  const [editRole, setEditRole] = useState<"admin" | "member">("member");
  const [editEmail, setEditEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Delete state
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<ApiUser | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [mailWorks, setMailWorks] = useState(false);
  const [addingToBoard, setAddingToBoard] = useState<ApiUser | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  // Off: accounts come by invitation only, and nobody is handed a password
  const passwordSignIn = usePasswordSignIn();
  const [confirmingAddress, setConfirmingAddress] = useState(false);
  const [confirmAddressOf, setConfirmAddressOf] = useState<ApiUser | null>(null);
  const [confirmAddressError, setConfirmAddressError] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState<ApiUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [confirmDeactivate, setConfirmDeactivate] = useState<ApiUser | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [togglingActive, setTogglingActive] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);

  const api = useApi();
  const { toast, dismiss } = useToast();
  const actionToasts = useRef<number[]>([]);

  // The action opens a dialog on this page, so it must not outlive the page it would open it on
  useEffect(() => {
    const ids = actionToasts.current;
    return () => ids.forEach((id) => dismiss(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    refreshInvitations();

    // Whether the notice below the password field is a promise or a lie: an instance with no mail
    // server sends nothing, and the admin has to know that before they walk away from the screen
    api
      .get("/api/admin/email")
      .then((settings: { configured?: boolean }) => setMailWorks(!!settings.configured))
      .catch(() => setMailWorks(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, authLoading]);

  // The list refresh that follows a write. Its own failure is not the write's failure — the write
  // landed — so it is reported as what it is, and never as an unhandled rejection.
  async function refreshUsers() {
    try {
      setUsers(await api.get("/api/users"));
    } catch {
      // No verb: this runs after a create, a save and a delete, and telling somebody "Saved" when
      // they deleted a user — who is still on screen, because this is the fetch that failed — is
      // the one message they cannot act on.
      toast(LIST_REFRESH_FAILED, "error");
    }
  }

  async function refreshInvitations() {
    try {
      setInvitations(await api.get("/api/invitations"));
    } catch {
      toast("The pending invitations could not be loaded", "error");
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);

    // The flag ends with the write, and the list refetch below is deliberately outside its life.
    // It gates the dialog's own ways out, so a flag still set across that fetch belonged to a
    // dialog that had already closed — and the next one opened into it (BP-565).
    let created: ApiUser;
    try {
      created = await api.post("/api/users", { username, password, fullName, email: newUserEmail });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
      setSaving(false);
      return;
    }
    setSaving(false);
    closeNew();
    // Before the refresh, so it does not wait on a slow list — and said at all, which it was not:
    // a create used to produce no line of its own, leaving a failed refresh as the only thing a new
    // account ever said.
    actionToasts.current.push(
      toast(
        `${created.fullName}'s account is ready. They will see no board until you add them to one.`,
        "success",
        { action: { label: "Add to a board", onClick: () => setAddingToBoard(created) } }
      )
    );
    await refreshUsers();
  }

  function openEdit(user: ApiUser) {
    setEditUser(user);
    setEditRole(user.role || "member");
    setEditEmail(user.email || "");
    setEmailError("");
    closePasswordField();
  }

  function closeNew() {
    setShowNew(false);
    setUsername("");
    setPassword("");
    setFullName("");
    // Cleared on cancel too, not only on success: an address typed for one person and abandoned
    // would otherwise sit four fields down, optional and unnoticed, when the form is next opened
    setNewUserEmail("");
    setError("");
  }

  function closePasswordField() {
    setNewPassword("");
    setPasswordError("");
    setShowPassword(false);
  }

  function closeEdit() {
    setEditUser(null);
    setEmailError("");
    closePasswordField();
  }

  async function handleEditSave() {
    if (!editUser || editSaving) return;
    setPasswordError("");
    setEmailError("");

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
        // Only when it actually changed: the value was read when the list loaded, and sending it
        // back on every save would quietly undo an address its owner edited in the meantime
        ...(editEmail !== (editUser.email ?? "") ? { email: editEmail } : {}),
        ...(passwordWasSet ? { password: newPassword } : {}),
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = err instanceof Error ? err.message : "Failed to update user";
      // Beside the field it belongs to, not in a toast that clears after three seconds and leaves
      // the offending address sitting there unmarked
      if (status === 409 || message.includes("email address")) {
        setEmailError(message);
      } else {
        toast(message, "error");
      }
      setEditSaving(false);
      return;
    }

    // Cleared with the PUT, before the refetch — see handleCreate.
    setEditSaving(false);
    closeEdit();
    // Before the refresh, not after it: the save is what the toast is about, and the line saying a
    // password was changed should not wait on a slow list to be re-read.
    toast(
      passwordWasSet
        ? `Password set for ${username}. They were signed out everywhere, API tokens, connected apps and enrolled machines included, and their sign-in providers were unlinked.`
        : "Saved",
      "success"
    );
    await refreshUsers();
  }

  async function confirmAddress() {
    if (!confirmAddressOf || confirmingAddress) return;
    setConfirmingAddress(true);
    setConfirmAddressError("");
    try {
      await api.put(`/api/users/${confirmAddressOf._id}`, { confirmEmail: true });
    } catch (err) {
      setConfirmAddressError(err instanceof Error ? err.message : "The address could not be confirmed");
      setConfirmingAddress(false);
      return;
    }
    setConfirmingAddress(false);
    toast(`${confirmAddressOf.email} confirmed`, "success");
    setConfirmAddressOf(null);
    await refreshUsers();
  }

  async function signOutEverywhere() {
    if (!confirmSignOut || signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await api.put(`/api/users/${confirmSignOut._id}`, { signOutEverywhere: true });
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : "They could not be signed out");
      setSigningOut(false);
      return;
    }
    setSigningOut(false);
    toast(`${confirmSignOut.username} was signed out everywhere`, "success");
    setConfirmSignOut(null);
    // Their providers were unlinked, which their card lists
    await refreshUsers();
  }

  async function deactivate() {
    if (!confirmDeactivate || togglingActive) return;
    setTogglingActive(true);
    setDeactivateError("");
    try {
      await api.put(`/api/users/${confirmDeactivate._id}`, { deactivate: true });
    } catch (err) {
      setDeactivateError(err instanceof Error ? err.message : "The account could not be deactivated");
      setTogglingActive(false);
      return;
    }
    setTogglingActive(false);
    toast(`${confirmDeactivate.username} is deactivated`, "success");
    setConfirmDeactivate(null);
    await refreshUsers();
  }

  async function reactivate(person: ApiUser) {
    if (togglingActive) return;
    setTogglingActive(true);
    try {
      await api.put(`/api/users/${person._id}`, { reactivate: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : "The account could not be reactivated", "error");
      setTogglingActive(false);
      return;
    }
    setTogglingActive(false);
    closeEdit();
    toast(`${person.username} can sign in again`, "success");
    await refreshUsers();
  }

  async function handleDelete() {
    if (!confirmDeleteUser || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.del(`/api/users/${confirmDeleteUser._id}`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete user");
      setDeleting(false);
      return;
    }
    setDeleting(false);
    setConfirmDeleteUser(null);
    toast("User deleted", "success");
    await refreshUsers();
  }

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const active = users.filter((u) => !u.deactivatedAt);
  const deactivated = users.filter((u) => u.deactivatedAt);
  const counts: Record<StatusFilter, number> = {
    all: users.length + invitations.length,
    active: active.length,
    invited: invitations.length,
    deactivated: deactivated.length,
  };
  const shownUsers = statusFilter === "all" ? users : statusFilter === "active" ? active : statusFilter === "deactivated" ? deactivated : [];
  const showInvitations = statusFilter === "all" || statusFilter === "invited";

  // Each account action closes this dialog, which would throw away what was typed in it
  const unsavedEdit =
    !!editUser && (editRole !== editUser.role || editEmail !== (editUser.email ?? "") || newPassword !== "");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Users</h2>
        <div className="flex gap-2">
          {passwordSignIn !== false && (
            <Button variant="secondary" onClick={() => setShowNew(true)}>
              New User
            </Button>
          )}
          <Button onClick={() => setShowInvite(true)}>Invite</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Show">
        {STATUS_FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={statusFilter === value}
            onClick={() => setStatusFilter(value)}
            className={`px-3 py-1.5 min-h-11 sm:min-h-0 rounded-lg text-sm border transition-colors ${
              statusFilter === value ? "border-primary bg-primary/20 text-primary" : "border-border text-text-muted hover:border-text"
            }`}
          >
            {label} <span className="tabular-nums">{counts[value]}</span>
          </button>
        ))}
      </div>

      {shownUsers.length === 0 && !(showInvitations && invitations.length > 0) && (
        <p className="text-sm text-text-muted">Nobody here.</p>
      )}

      {/* auto-fill rather than a fixed 1/2/3: at this content width three columns left each card
          145px for a name and its role pill, which needs 165px, so every ordinary name truncated
          while a whole empty column sat beside it (BP-351) */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
        {shownUsers.map((u) => (
          <Card
            key={u._id}
            onClick={() => openEdit(u)}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/30 flex items-center justify-center text-sm font-medium flex-shrink-0">
                {u.fullName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-medium truncate">{u.fullName}</p>
                  <span
                    className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                      u.role === "admin"
                        ? "bg-primary/20 text-primary"
                        : "bg-bg-input text-text-muted"
                    }`}
                  >
                    {u.role === "admin" ? "Admin" : "Member"}
                  </span>
                  {u.deactivatedAt ? (
                    <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-danger/15 text-danger">
                      Deactivated
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-success/15 text-success">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-sm text-text-muted truncate">
                  @{u.username}
                </p>
                <p className="text-xs text-text-muted">
                  {u.lastActiveAt ? `Last active ${timeAgo(u.lastActiveAt)}` : "No sign-in recorded"}
                  {" · "}
                  {u.signInMethods && u.signInMethods.length > 0 ? u.signInMethods.join(", ") : "No way to sign in"}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {showInvitations && <PendingInvitations invitations={invitations} onChanged={refreshInvitations} />}

      <SignUpDomains />

      <AddToBoardModal person={addingToBoard} onClose={() => setAddingToBoard(null)} />

      <InviteModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        onInvited={refreshInvitations}
      />

      {/* Create User Modal */}
      <Modal
        open={showNew}
        onClose={closeNew}
        closeDisabled={saving}
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
          <div>
            <Input
              id="newUserEmail"
              label="Email"
              type="email"
              autoComplete="off"
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Creating..." : "Create User"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={closeNew}
              disabled={saving}
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
        closeDisabled={editSaving}
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
              <Input
                id="editUserEmail"
                label="Email"
                type="email"
                autoComplete="off"
                value={editEmail}
                error={emailError}
                onChange={(e) => setEditEmail(e.target.value)}
              />
            </div>

            {passwordSignIn !== false && !editUser.deactivatedAt && (
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
                    The password itself is never emailed — tell {editUser.fullName} yourself.{" "}
                    {mailWorks && editUser.email
                      ? `${editUser.email} is told that it changed, and saving signs them out everywhere, API tokens, connected apps and enrolled machines included, and unlinks their sign-in providers.`
                      : "Nothing reaches them either, so this is the only way they will know. Saving signs them out everywhere, API tokens, connected apps and enrolled machines included, and unlinks their sign-in providers."}
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
                    {/* Generating shows it in the same move: a password nobody can read is one
                        nobody can pass on, and this one only exists to be passed on */}
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0"
                      onClick={() => {
                        setNewPassword(generatePassword());
                        setShowPassword(true);
                        setPasswordError("");
                      }}
                    >
                      Generate
                    </Button>
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
            )}

            {currentUser?._id !== editUser._id && (
              <div className="border-t border-border pt-4 space-y-3">
                {unsavedEdit && (
                  <p className="text-sm text-text-muted">Save or cancel your changes first.</p>
                )}
                {editUser.email && !editUser.emailVerifiedAt && (
                  <div>
                    <p className="text-sm font-medium mb-1">Address not confirmed</p>
                    <p className="text-sm text-text-muted mb-2">
                      Nothing has proven that {editUser.email} reaches them, so a sign-in provider cannot sign
                      them in by it.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={unsavedEdit}
                      onClick={() => {
                        setConfirmAddressOf(editUser);
                        closeEdit();
                      }}
                    >
                      Confirm address
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {/* Deactivating already ended every session; here it would only unlink the
                      providers deactivation keeps for the way back */}
                  {!editUser.deactivatedAt && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={unsavedEdit}
                      onClick={() => {
                        setConfirmSignOut(editUser);
                        closeEdit();
                      }}
                    >
                      Sign out everywhere
                    </Button>
                  )}
                  {editUser.deactivatedAt ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => reactivate(editUser)}
                      disabled={togglingActive || unsavedEdit}
                    >
                      {togglingActive ? "Reactivating…" : "Reactivate"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={unsavedEdit}
                      onClick={() => {
                        setConfirmDeactivate(editUser);
                        closeEdit();
                      }}
                    >
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
            )}

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
                disabled={editSaving}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={editSaving || unsavedEdit}
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
        open={!!confirmAddressOf}
        onClose={() => {
          setConfirmAddressOf(null);
          setConfirmAddressError("");
        }}
        onConfirm={confirmAddress}
        title="Confirm address"
        message={`Whoever holds ${confirmAddressOf?.email ?? ""} at a sign-in provider will be able to sign in as ${confirmAddressOf?.username ?? ""}. Confirm only if you know it is theirs.`}
        confirmLabel="Confirm address"
        loadingLabel="Confirming…"
        loading={confirmingAddress}
        error={confirmAddressError}
      />
      <ConfirmDialog
        open={!!confirmDeactivate}
        onClose={() => {
          setConfirmDeactivate(null);
          setDeactivateError("");
        }}
        onConfirm={deactivate}
        title="Deactivate account"
        message={`${confirmDeactivate?.fullName ?? ""} can no longer sign in, and every session, API token, connected app and enrolled machine of theirs ends. Their tasks and history stay, and you can reactivate them.`}
        confirmLabel="Deactivate"
        loadingLabel="Deactivating…"
        loading={togglingActive}
        error={deactivateError}
      />
      <ConfirmDialog
        open={!!confirmSignOut}
        onClose={() => {
          setConfirmSignOut(null);
          setSignOutError("");
        }}
        onConfirm={signOutEverywhere}
        title="Sign out everywhere"
        message={`Ends every session, API token, connected app and enrolled machine of ${confirmSignOut?.fullName ?? ""}, and unlinks their sign-in providers.${
          passwordSignIn === false
            ? " They sign back in by a confirmed address with an OpenID Connect or Google provider; GitHub alone cannot sign them in again."
            : ""
        }`}
        confirmLabel="Sign out everywhere"
        loadingLabel="Signing out…"
        loading={signingOut}
        error={signOutError}
      />
      <ConfirmDialog
        open={!!confirmDeleteUser}
        onClose={() => {
          setConfirmDeleteUser(null);
          setDeleteError("");
        }}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete "${confirmDeleteUser?.fullName}"? This action cannot be undone.`}
        confirmLabel="Delete User"
        loading={deleting}
        error={deleteError}
      />
    </div>
  );
}
