import mongoose, { type PipelineStage } from "mongoose";
import { Task } from "@/models/task";
import type { ILinkedPR } from "@/types";

/** A stored link's provider. Written since the field existed; absent means GitHub. */
export function providerOf(link: { provider?: string | null }): string {
  return link.provider ?? "github";
}

/**
 * The links of this provider the round has nothing to say about.
 *
 * A fetch is a window, not a history: GitHub answers with its open pull requests plus the thirty
 * most recently updated closed ones, GitLab with a hundred by `updated_at`, and neither paginates.
 * A pull request that is simply outside that window is **unknown**, not gone — so a task holding a
 * link to one merged last quarter keeps it, while a link whose number came back in this round's
 * fetch and was not matched to this task is a fact and is dropped (BP-610, BP-617).
 */
export function unseenLinks(
  stored: ILinkedPR[] | undefined,
  provider: "github" | "gitlab",
  seen: Set<number>
): ILinkedPR[] {
  return (stored ?? []).filter(
    (link) => providerOf(link) === provider && !seen.has(link.number)
  );
}

/**
 * How many of a task's links this write removes: the round saw the pull request and did not give
 * it to this task. A link the round re-matched to the same task is rewritten, not removed, and a
 * link the round never saw is kept.
 */
export function droppedCount(
  stored: ILinkedPR[] | undefined,
  provider: "github" | "gitlab",
  seen: Set<number>,
  matched: Set<number>
): number {
  return (stored ?? []).filter(
    (link) => providerOf(link) === provider && seen.has(link.number) && !matched.has(link.number)
  ).length;
}

/**
 * The update that rewrites one provider's links on a task and leaves the other provider's alone.
 *
 * An aggregation pipeline rather than a read-mutate-save, because two syncs of the same task
 * overlap easily — a scheduled one against a double-clicked manual one — and the later `save()`
 * silently dropped whatever the earlier had added (BP-559).
 *
 * `$filter` keeps two kinds of link: the other provider's, and this provider's own links whose
 * number this round never saw. `docs` is what the round did see for this task. Before BP-617 the
 * second kind was dropped, so a task holding an older pull request lost it the moment a newer one
 * appeared — silently, on an ordinary project, with no rename or repoint needed.
 *
 * `?? "github"` in reverse: a link stored before the provider field existed is GitHub's, so a
 * GitHub sync owns it rather than leaving it beside its own replacement.
 *
 * Mongoose does not cast a pipeline update, so `docs` must already hold real `Date`s.
 */
export function replaceProviderLinks(
  provider: "github" | "gitlab",
  docs: unknown[],
  seen: number[]
): PipelineStage.Set[] {
  return [
    {
      $set: {
        linkedPRs: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ["$linkedPRs", []] },
                cond: {
                  $or: [
                    { $ne: [{ $ifNull: ["$$this.provider", "github"] }, provider] },
                    { $not: [{ $in: ["$$this.number", seen] }] },
                  ],
                },
              },
            },
            // `$literal`: in a pipeline a string is an expression, and `title` is a name an
            // outsider chooses — "$title" was stored as the task's own title.
            { $literal: docs },
          ],
        },
      },
    },
  ];
}

/**
 * Issuing that update is part of it, not the caller's business: Mongoose refuses a pipeline
 * without `updatePipeline`, and the subdocument ids `save()` used to mint have to be minted here
 * instead. Both are invisible to any test that mocks the model, so both live in one place the
 * end-to-end test can drive (`e2e/pr-link-replacement.spec.ts`).
 *
 * `seen` is every pull request number this round's fetch returned, matched or not — the round's
 * whole field of view, not this task's share of it. That is what makes a removal a fact.
 */
export async function writeProviderLinks(
  taskId: mongoose.Types.ObjectId,
  provider: "github" | "gitlab",
  docs: (Record<string, unknown> & { _id?: never })[],
  seen: number[]
): Promise<void> {
  const withIds = docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  await Task.updateOne({ _id: taskId }, replaceProviderLinks(provider, withIds, seen), {
    updatePipeline: true,
  });
}
