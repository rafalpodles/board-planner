"use client";

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject } from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const api = useApi();

  const [project, setProject] = useState<ApiProject | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [newComponent, setNewComponent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}`)
      .then((p: ApiProject) => {
        setProject(p);
        setName(p.name);
        setDescription(p.description);
        setGithubRepo(p.githubRepo || "");
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const updated = await api.put(`/api/projects/${projectId}`, {
        name,
        description,
        githubRepo,
      });
      setProject(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function addComponent() {
    if (!newComponent.trim()) return;
    try {
      await api.post(`/api/projects/${projectId}/components`, {
        name: newComponent.trim(),
      });
      setProject((p) =>
        p ? { ...p, components: [...p.components, newComponent.trim()] } : p
      );
      setNewComponent("");
    } catch (err) {
      console.error(err);
    }
  }

  async function removeComponent(comp: string) {
    try {
      await api.del(`/api/projects/${projectId}/components`, { name: comp });
      setProject((p) =>
        p ? { ...p, components: p.components.filter((c) => c !== comp) } : p
      );
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}`);
      router.replace("/projects");
    } catch (err) {
      console.error(err);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading || !project) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <button
        onClick={() => router.push(`/projects/${projectId}`)}
        className="text-sm text-text-muted hover:text-text mb-4 inline-block min-h-[44px] flex items-center"
      >
        &larr; Back to board
      </button>

      <h1 className="text-2xl font-bold mb-6">Project Settings</h1>

      <form onSubmit={handleSave} className="space-y-4 mb-8">
        <Input
          label="Project Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input label="Project Key" value={project.key} disabled />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          label="GitHub Repository"
          value={githubRepo}
          onChange={(e) => setGithubRepo(e.target.value)}
          placeholder="owner/repo (e.g. rafalpodles/claude-planner)"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </form>

      {/* Components */}
      <div className="mb-8">
        <h2 className="font-semibold mb-3">Components</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {project.components.map((comp) => (
            <span
              key={comp}
              className="inline-flex items-center gap-1 text-sm bg-bg-input px-3 py-1 rounded-full"
            >
              {comp}
              <button
                onClick={() => removeComponent(comp)}
                className="text-text-muted hover:text-danger ml-1 min-w-[24px] min-h-[24px] flex items-center justify-center"
              >
                &times;
              </button>
            </span>
          ))}
          {project.components.length === 0 && (
            <p className="text-sm text-text-muted">No components</p>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={newComponent}
            onChange={(e) => setNewComponent(e.target.value)}
            placeholder="Add component..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addComponent();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={addComponent}>
            Add
          </Button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="border-t border-border pt-6">
        <h2 className="font-semibold text-danger mb-3">Danger Zone</h2>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Delete Project
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete Project"
        message={`Are you sure you want to delete "${project.name}" and all its tasks? This action cannot be undone.`}
        confirmLabel="Delete Project"
        loading={deleting}
      />
    </div>
  );
}
