import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { isAIEnabled, generateTask, ExistingTaskSummary } from "@/lib/ai";
import { getSettings } from "@/models/settings";

async function fetchReadme(githubRepo: string): Promise<string | undefined> {
  if (!githubRepo) return undefined;

  // Support both "owner/repo" and full URL formats
  const ownerRepo = githubRepo
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .trim();

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
    fetchReadme(project.githubRepo || ""),
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

  try {
    const settings = await getSettings();
    const task = await generateTask(
      prompt.trim(),
      {
        name: project.name,
        description: project.description || "",
        components: project.components || [],
        readme,
        existingTasks,
      },
      settings.aiModel
    );

    return NextResponse.json(task);
  } catch (err) {
    console.error("AI generation failed:", err);
    return NextResponse.json(
      { error: "AI generation failed. Please try again." },
      { status: 500 }
    );
  }
});
