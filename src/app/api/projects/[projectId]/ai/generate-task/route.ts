import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import type { HydratedDocument } from "mongoose";
import type { IProject } from "@/types";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { isAIEnabled, generateTask, ExistingTaskSummary } from "@/lib/ai";
import { choiceFieldsForPrompt, resolveGeneratedFields } from "@/lib/ai-fields";
import { getSettings } from "@/models/settings";
import { bareHost, hostOf, projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";

export const MAX_PROMPT_LENGTH = 10_000;
/** Generations one person may start in the rate limiter's 15-minute window */
export const GENERATIONS_PER_USER_WINDOW = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Generations one project may run in a day, on the instance's own OpenAI key */
export function dailyGenerationCap(): number {
  const configured = Number(process.env.AI_DAILY_GENERATION_CAP);
  return Number.isInteger(configured) && configured > 0 ? configured : 200;
}

// One generation at a time per person: nothing else stops a loop from queueing hundreds in parallel
const inFlight = new Set<string>();

export async function fetchReadme(githubRepo: string): Promise<string | undefined> {
  if (!githubRepo) return undefined;

  const trimmed = githubRepo.trim().replace(/\/+$/, "").replace(/\.git$/, "");

  /**
   * raw.githubusercontent.com serves github.com and nothing else. A GitHub Enterprise host reaches
   * here now that `repositoryProvider` recognises this instance's own (BP-634), and without a check
   * the corporate hostname and a private repository's path went out to GitHub inside a url that
   * could only 404.
   *
   * `hostOf` rather than a regex written here, because the field accepts more spellings than any
   * one pattern catches and the first two attempts at this each missed one — `git@host:path` hides
   * the host from a `https?://` test, and `ssh://git@host/path` hides it from both that and an
   * scp-form test while `repositoryProvider` reads it happily (three reviewers, independently).
   * One rule for the host, or the two readers of the same field disagree about the same string.
   *
   * A host it cannot read at all — a bare `owner/repo`, or a per-account ssh alias — is left as it
   * always was: GitHub's by assumption.
   */
  const host = bareHost(hostOf(trimmed));
  if (host && host !== "github.com" && !host.endsWith(".github.com")) return undefined;

  // What is left once the host is taken off, whichever way it was spelled. Case is preserved:
  // raw.githubusercontent serves a path, and a lower-cased one is a different path — which is why
  // this is not `parseRemote`, whose job is comparison rather than addressing.
  const ownerRepo = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\//i, "")
    .replace(/^[^/]+@[^/:]+:/, "")
    .replace(/^\/+/, "");

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

export const POST = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;

  if (!isAIEnabled()) {
    return NextResponse.json(
      { error: "AI is not configured. Set OPENAI_API_KEY environment variable." },
      { status: 501 }
    );
  }

  await connectDB();

  const read = await readJsonBody<{ prompt?: unknown }>(request);
  if (!read.ok) return read.response;
  const { prompt } = read.value;

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return NextResponse.json(
      { error: "prompt is required" },
      { status: 400 }
    );
  }
  if (prompt.trim().length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: `That prompt is too long — ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters at most.` },
      { status: 400 }
    );
  }

  // Taken with no await between the check and the claim, or a burst all passes the check at once
  const holder = String(user._id);
  if (inFlight.has(holder)) {
    return NextResponse.json({ error: "A generation is already running." }, { status: 409 });
  }
  inFlight.add(holder);
  try {
    // Every generation is spent on the instance's own key, so each one counts whether or not it
    // succeeds — and is counted in the same write that is compared, so a burst cannot slip past
    // the budget between a check and a record (BP-323)
    if ((await countAttempt(sourceKey(`user:${holder}`, "ai-generate"))) > GENERATIONS_PER_USER_WINDOW) {
      return NextResponse.json(
        { error: "Too many generations. Try again in 15 minutes." },
        { status: 429 }
      );
    }
    const cap = dailyGenerationCap();
    if ((await countAttempt(`ai-generate:day:${projectId}`, DAY_MS)) > cap) {
      return NextResponse.json(
        { error: `This project has used its ${cap} AI generations for the day.` },
        { status: 429 }
      );
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return await generate(project, projectId, prompt);
  } finally {
    inFlight.delete(holder);
  }
});

async function generate(project: HydratedDocument<IProject>, projectId: string, prompt: string) {
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
}
