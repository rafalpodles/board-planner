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
 * Only the tasks this pass reaches, mind. A task that *does* have a pull request in the window is
 * written by the first loop instead, and `replaceProviderLinks` there replaces this provider's
 * links wholesale — so an older link of its own, outside the window, is already dropped today on
 * `origin/main`, before any of this runs. That is a separate defect, named rather than implied
 * away: the file argues for a conservatism its first half does not yet practise.
 *
 * So one rule, and every removal carries the round's own evidence for it: the number came back in
 * this round's fetch and the matcher did not give it to this task. It was retitled onto another
 * task, lost its key, or the key left `formerKeys`.
 *
 * A pull request **deleted** at the provider is therefore not covered at all: it is absent from a
 * bounded response exactly like one that did not fit. Neither is a repository **renamed** there,
 * whose links look exactly like those of a repository the project was repointed away from — the
 * URL rule that tried to catch the repoint was removed for that reason, because guessing deletes
 * correct data permanently and the links are outside the window for ever.
 *
 * **Repointing** is not "uncovered" so much as swept by coincidence, which is worth saying out
 * loud: the new repository's numbering starts again, so each time it mints a number a task from
 * the old repository already holds, that task's link is contradicted and goes. They are stale by
 * this ticket's own definition, so the removals are right — but which ones go, and when, is
 * decided by how far an unrelated counter has run. Expect a count with nothing behind it: weeks
 * after a repoint, with nothing touched at the provider, a sync reports links removed. That is
 * this, not a bug to chase.
 *
 * And it is why a number is safe to compare where a URL was not. A number is only ever compared
 * inside one counter, and a repository renamed or transferred keeps its pull request numbers — so
 * the fetch returns the same pull request under the same number, and it either still matches its
 * task or genuinely does not. A URL compares across identity instead, which is exactly what a
 * rename breaks. The two collide only across two counters, which means two repositories, which
 * means a repoint.
 *
 * The rule is only ever as accurate as the matcher it defers to: where `matchPRsToTasks` gives a
 * pull request to the wrong task, this deletes the right task's link rather than leaving a
 * duplicate on the wrong card. The pattern `matchPRsToTasks` builds has no word boundary before
 * the key, which is BP-611.
 *
 * `?? "github"`, as everywhere else here: a link stored before the provider field existed is
 * GitHub's, and the schema default is applied on hydration rather than stored.
 *
 * A number is named once however many link documents carry it, because what the count in the
 * toast means is pull requests that stopped being this task's — the same unit as the `prsLinked`
 * standing beside it. A task holding one pull request twice therefore reports one and loses two.
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
 *
 * `linkedThisRound` is the set of task numbers the round **matched**, not the set it wrote. The
 * two look interchangeable and are not: a task whose links the round left alone because they were
 * already right still holds numbers the fetch returned, so sourcing this from what was written
 * would sweep exactly the links that are correct, on every run.
 *
 * The read is one query per sync over every task in the project that holds a link of this
 * provider — `project_1_taskNumber_1` bounds it to the project, and nothing indexes `linkedPRs`,
 * so the array test is applied after the fetch. That is sized for a button somebody presses.
 *
 * `timestamps: false`, which the first pass does not pass and should: the dashboard reads a done
 * task's `updatedAt` as the date it was finished (`src/app/api/projects/[projectId]/stats/route.ts`),
 * and taking a stale link off a task finished last quarter is not that task being finished today.
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
      timestamps: false,
    });
    removed += numbers.length;
  }

  return removed;
}
