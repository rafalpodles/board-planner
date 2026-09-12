import mongoose, { type PipelineStage } from "mongoose";
import { Task } from "@/models/task";

/**
 * The update that replaces one provider's links on a task and leaves the other provider's alone.
 *
 * An aggregation pipeline rather than a read-mutate-save, because two syncs of the same task
 * overlap easily — a scheduled one against a double-clicked manual one — and the later `save()`
 * silently dropped whatever the earlier had added (BP-559).
 *
 * `?? "github"` in reverse: a link stored before the provider field existed is GitHub's, so a
 * GitHub sync must replace it rather than leave it beside its own replacement.
 *
 * Mongoose does not cast a pipeline update, so `docs` must already hold real `Date`s.
 */
export function replaceProviderLinks(
  provider: "github" | "gitlab",
  docs: unknown[]
): PipelineStage.Set[] {
  return [
    {
      $set: {
        linkedPRs: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ["$linkedPRs", []] },
                cond: { $ne: [{ $ifNull: ["$$this.provider", "github"] }, provider] },
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
 */
export async function writeProviderLinks(
  taskId: mongoose.Types.ObjectId,
  provider: "github" | "gitlab",
  docs: (Record<string, unknown> & { _id?: never })[]
): Promise<void> {
  const withIds = docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  await Task.updateOne({ _id: taskId }, replaceProviderLinks(provider, withIds), {
    updatePipeline: true,
  });
}

/**
 * The update that removes named links of one provider and leaves every other link alone.
 *
 * A pipeline for the same reason `replaceProviderLinks` is one: the surviving array is computed
 * from the document as it is at write time, so an overlapping sync of either provider cannot be
 * dropped by a copy read a moment earlier (BP-559). Only the numbers decided about are removed —
 * anything a concurrent sync added in between is not in the list and survives.
 */
export function removeProviderLinks(
  provider: "github" | "gitlab",
  numbers: number[]
): PipelineStage.Set[] {
  return [
    {
      $set: {
        linkedPRs: {
          $filter: {
            input: { $ifNull: ["$linkedPRs", []] },
            cond: {
              $not: [
                {
                  $and: [
                    { $eq: [{ $ifNull: ["$$this.provider", "github"] }, provider] },
                    { $in: ["$$this.number", { $literal: numbers }] },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];
}

export interface StoredProviderLink {
  provider?: "github" | "gitlab" | null;
  number: number;
}

/**
 * Which of a task's stored links this round of the sync has **positively contradicted** (BP-610).
 *
 * Not "everything the round did not confirm". Neither provider is asked for its whole history:
 * GitHub returns the open pull requests plus the thirty most recently updated closed ones, GitLab
 * the first hundred by `updated_at`. A task whose pull request merged last quarter falls out of
 * that window on every sync while remaining perfectly correct, so treating absence as removal
 * would delete good links from healthy projects. Absent is unknown, not gone.
 *
 * So one rule, and every removal carries the round's own evidence for it: the number came back in
 * this round's fetch and the matcher did not give it to this task. It was retitled onto another
 * task, lost its key, or the key left `formerKeys`.
 *
 * Two of the ways BP-610 lists are deliberately **not** covered, because nothing here can tell
 * them apart from a link that is simply old: a pull request deleted at the provider is absent from
 * a bounded response exactly like one that did not fit, and a repository renamed at the provider
 * leaves its links looking exactly like a repository the project was repointed away from. Both
 * would be removed on a guess, and a guess here deletes correct data permanently — the links are
 * outside the window for ever, so no later sync puts them back.
 *
 * `?? "github"`, as everywhere else here: a link stored before the provider field existed is
 * GitHub's, and the schema default is applied on hydration rather than stored.
 */
export function contradictedLinkNumbers(
  links: StoredProviderLink[],
  provider: "github" | "gitlab",
  seenNumbers: ReadonlySet<number>
): number[] {
  const numbers = new Set<number>();
  for (const link of links) {
    if ((link.provider ?? "github") !== provider) continue;
    if (seenNumbers.has(link.number)) numbers.add(link.number);
  }
  return [...numbers];
}

/**
 * The second pass a sync owes the tasks it did not visit.
 *
 * The first pass writes only the tasks in this round's grouping, so a pull request that stops
 * matching a task takes its task out of the loop and leaves the stale link behind for ever
 * (BP-610). This walks the tasks that hold links of this provider and are not in the grouping —
 * a task in it has had its links of this provider replaced wholesale already — and removes the
 * ones `contradictedLinkNumbers` can show are no longer this task's. A task with nothing
 * contradicted is not written at all.
 */
export async function pruneContradictedLinks(opts: {
  projectId: string;
  provider: "github" | "gitlab";
  linkedThisRound: ReadonlySet<number>;
  seenNumbers: ReadonlySet<number>;
}): Promise<number> {
  const { projectId, provider, linkedThisRound, seenNumbers } = opts;

  // An unmarked link is GitHub's, and a stored document has no `provider` field for the query to
  // match — the schema's default only appears on hydration, which a query does not do.
  const owned =
    provider === "github"
      ? { $or: [{ provider: "github" }, { provider: { $exists: false } }, { provider: null }] }
      : { provider: "gitlab" };

  const holders = await Task.find(
    { project: projectId, linkedPRs: { $elemMatch: owned } },
    { taskNumber: 1, linkedPRs: 1 }
  ).lean<{ _id: mongoose.Types.ObjectId; taskNumber: number; linkedPRs?: StoredProviderLink[] }[]>();

  let removed = 0;
  for (const holder of holders) {
    if (linkedThisRound.has(holder.taskNumber)) continue;

    const numbers = contradictedLinkNumbers(holder.linkedPRs ?? [], provider, seenNumbers);
    if (numbers.length === 0) continue;

    await Task.updateOne({ _id: holder._id }, removeProviderLinks(provider, numbers), {
      updatePipeline: true,
    });
    removed += numbers.length;
  }

  return removed;
}
