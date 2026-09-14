import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { isAIEnabled, generateTask, ExistingTaskSummary } from "@/lib/ai";
import { choiceFieldsForPrompt, resolveGeneratedFields } from "@/lib/ai-fields";
import { getSettings } from "@/models/settings";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";

export async function fetchReadme(githubRepo: string): Promise<string | undefined> {
  if (!githubRepo) return undefined;

  const trimmed = githubRepo.trim().replace(/\/+$/, "").replace(/\.git$/, "");

  // Every spelling `repositoryUrl` accepts, because each carries the host somewhere different —
  // and an ssh remote is the one that hides it from a `https?://` test, so `git@github.com:o/r`
  // was pasted into the url whole (found by probing this function rather than by reading it).
  const ssh = /^[^/]+@([^/:]+):(.+)$/.exec(trimmed);
  const named = ssh?.[1] ?? /^https?:\/\/([^/]+)/i.exec(trimmed)?.[1] ?? "";
  // A dot is what separates a real hostname from a per-account ssh alias like `github-work`, which
  // only that machine's ssh config resolves — the same rule `repo-match.parseRemote` uses, so the
  // two do not disagree about the same string.
  const host = named.includes(".") ? named.toLowerCase() : "";

  // raw.githubusercontent.com serves github.com and nothing else. A GitHub Enterprise host reaches
  // here now that `repositoryProvider` recognises this instance's own (BP-634), and without this
  // the corporate hostname and a private repository's path went out to GitHub inside a url that
  // could only 404 (found in review). A host it cannot read at all — a bare `owner/repo`, or a
  // per-account ssh alias — is left as it always was: GitHub's by assumption.
  if (host && host !== "github.com" && !host.endsWith(".github.com")) return undefined;

  // Support "owner/repo", an https url and an ssh remote. Case is preserved: raw.githubusercontent
  // serves a path, and a lower-cased one is a different path.
  const ownerRepo = ssh ? ssh[2] : trimmed.replace(/^https?:\/\/github\.com\//i, "");

  if (!ownerRepo.includes("/")) return undefined;

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${ownerRepo}/main/README.md`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.slice(0, 2000);
  } catch {
    return undefined;
  }
}

export const GET = withProjectAccess(async () => {
  return NextResponse.json({ enabled: isAIEnabled() });
});

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;

  if (!isAIEnabled()) {
    return NextResponse.json(
      { error: "AI is not configured. Set OPENAI_API_KEY environment variable." },
      { status: 501 }
    );
  }

  await connectDB();

  const { prompt } = await request.json();

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return NextResponse.json(
      { error: "prompt is required" },
      { status: 400 }
    );
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [readme, tasks] = await Promise.all([
    // raw.githubusercontent.com only serves github.com, so a project hosted anywhere else — and
    // that now includes this instance's own GitHub Enterprise — gets no README rather than a
    // request that cannot work, sent to a host that should never see the address
    fetchReadme(repositoryProvider(project) === "github" ? projectRepositoryUrl(project) : ""),
    Task.find(
      { project: projectId, status: { $ne: "done" } },
      "taskNumber title status description"
    )
      .sort({ taskNumber: -1 })
      .limit(50)
      .lean(),
  ]);

  const existingTasks: ExistingTaskSummary[] = tasks.map((t) => ({
    taskNumber: t.taskNumber,
    title: t.title,
    status: t.status,
    description: t.description || "",
  }));

  const choiceFields = choiceFieldsForPrompt(project.customFields || []);

  try {
    const settings = await getSettings();
    const task = await generateTask(
      prompt.trim(),
      {
        name: project.name,
        description: project.description || "",
        choiceFields,
        categories: (project.categories || []).map((c) => c.name),
        readme,
        existingTasks,
      },
      settings.aiModel
    );

    // Resolved here, where the field definitions live, so the client never has to work
    // out which field an answer belongs to
    const customFieldValues = resolveGeneratedFields(task.fields, project.customFields || []);

    return NextResponse.json({ ...task, customFieldValues });
  } catch (err) {
    console.error("AI generation failed:", err);
    return NextResponse.json(
      { error: "AI generation failed. Please try again." },
      { status: 500 }
    );
  }
});
