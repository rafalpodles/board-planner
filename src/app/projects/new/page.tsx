"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

export default function NewProjectPage() {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const api = useApi();
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const project = await api.post("/api/projects", {
        name,
        key: key.toUpperCase(),
        description,
      });
      router.push(`/projects/${project._id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-6">New Project</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Project Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Project"
          required
        />
        <Input
          label="Project Key"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="MP"
          maxLength={5}
          required
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project about?"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-3">
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create Project"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.back()}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
