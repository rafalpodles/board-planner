import mongoose, { type PipelineStage } from "mongoose";
import { logActivity } from "@/lib/activity";
import { Task } from "@/models/task";
import type { ILinkedPR } from "@/types";

/** A stored link's provider. Written since the field existed; absent means GitHub. */
export function providerOf(link: { provider?: string | null }): string {
  return link.provider ?? "github";
}

/** Where a provider puts the number in a pull request's web address. */
const REQUEST_PATH = { github: "/pull/", gitlab: "/-/merge_requests/" } as const;

/**
 * Everything this round saw, named by **url**.
 *
 * It used to be named by number, and a number is only unique inside one repository: repoint a
 * project's `repositoryUrl` at a different repository and a round of the new one that saw #12
 * contradicted a stored link to the *old* repository's #12 — a real pull request, deleted over a
 * collision the round never observed (BP-631). A url is the repository and the number together,
 * which is the repository scoping without a second parsing pass.
 *
 * The round also claims the url the **project's own configured repository** would give each pull
 * request it saw, which is not redundant. GitHub answers a renamed repository through a redirect
 * and returns the *new* name in `html_url`, while the project still names the old one — so without
 * this the links written before the rename would stop being contradicted, and every task would
 * hold two badges for one pull request for ever.
 *
 * That covers the rename as it is actually lived through: the repository is renamed, and the
 * project's setting is still the old name until somebody gets round to it. It does **not** cover
 * the moment after the setting is changed too — at which point a rename is byte-identical to a
 * repoint, from the fetch and from the setting alike, and this rule chooses *keep*. A task
 * carrying a link written under the old name then keeps it beside the new one: one pull request,
 * two badges, stable for ever, with no row saying anything went.
 *
 * Chosen rather than overlooked. The two are indistinguishable from anything this code can see,
 * so the choice is which way to be wrong: a visible duplicate that redirects to the same place, or
 * the silent deletion of a link to a pull request that still exists (BP-631's defect). Pinned by
 * `github-sync.test.ts`, so it is a decision and not an accident.
 *
 * Exact strings on both sides rather than a case-folded comparison, because the same rule has to
 * hold in the aggregation pipeline, in this module's counting and in the second pass's database
 * query, and only one of those three folds case cheaply.
 *
 * So the claim is only as good as the configured url's spelling, and two spellings make it a claim
 * about nothing: a different case, and an ssh remote (`git@github.com:o/r.git`), which no provider
 * puts a pull request under. Both land in the same place as the paragraph above — a rename showing
 * two badges rather than losing a link.
 */
export function seenUrls(
  provider: "github" | "gitlab",
  repositoryUrl: string,
  fetched: { number: number; url?: string | null }[]
): string[] {
  // Trailing slash first: `…/board.git/` is a spelling a person types, and stripping `.git` from
  // the other end would leave it in place.
  const base = repositoryUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const own = base ? `${base}${REQUEST_PATH[provider]}` : "";
  const urls = new Set<string>();
  for (const request of fetched) {
    if (request.url) urls.add(request.url);
    if (own) urls.add(`${own}${request.number}`);
  }
  return [...urls];
}

/**
 * The links of this provider the round has nothing to say about.
 *
 * A fetch is a window, not a history: GitHub answers with its open pull requests plus the thirty
 * most recently updated closed ones, GitLab with a hundred by `updated_at`, and neither paginates.
 * A pull request that is simply outside that window is **unknown**, not gone — so a task holding a
 * link to one merged last quarter keeps it, while a link whose url came back in this round's fetch
 * and was not matched to this task is a fact and is dropped (BP-610, BP-617).
 */
export function unseenLinks(
  stored: ILinkedPR[] | undefined,
  provider: "github" | "gitlab",
  seen: Set<string>
): ILinkedPR[] {
  return (stored ?? []).filter((link) => providerOf(link) === provider && !seen.has(link.url));
}

/**
 * The links this write removes: the round saw the pull request and did not give it to this task.
 * A link the round re-matched to the same task is rewritten, not removed, and a link the round
 * never saw is kept.
 *
 * A stored link carrying no url at all — which the schema forbids and only the two syncs write —
 * is never in `seen`, so it is kept. That is the safe direction for a shape nothing can identify.
 */
export function removedLinks(
  stored: ILinkedPR[] | undefined,
  provider: "github" | "gitlab",
  seen: Set<string>,
  matched: Set<string>
): ILinkedPR[] {
  return (stored ?? []).filter(
    (link) => providerOf(link) === provider && seen.has(link.url) && !matched.has(link.url)
  );
}

/** The links this write puts on the task that were not on it before. */
export function addedLinks<T extends { url: string }>(
  stored: ILinkedPR[] | undefined,
  provider: "github" | "gitlab",
  docs: T[]
): T[] {
  const held = new Set(
    (stored ?? []).filter((link) => providerOf(link) === provider).map((link) => link.url)
  );
  return docs.filter((doc) => !held.has(doc.url));
}

/**
 * The trace a link change leaves on the task it changed (BP-628).
 *
 * A row rather than a task write: `activityLog` is its own collection, so this does not
 * reintroduce the `updatedAt` corruption `writeProviderLinks` goes out of its way to avoid — and
 * `updatedAt` was the last per-task trace a link had, which is what made "there was a pull request
 * here last week" unanswerable.
 *
 * `actor` is null on a scheduler tick, and stays null rather than borrowing a name. That is
 * deliberately not what the auto-transition does with the same absence: a status change reads as
 * somebody's decision and an invented author makes it unanswerable, while "GitHub no longer gives
 * this pull request to this task" is a fact about GitHub that no person authored.
 *
 * Nothing is written when nothing changed, so a round that only refreshed a badge is silent.
 *
 * `added` and `removed` are computed from the task as it was read, and two rounds of the same
 * provider overlap easily — a tick against a double-clicked Sync now. Both can read "no link",
 * both write, and both log: one link, two rows. The link itself survives that (the write is one
 * atomic pipeline update, BP-559); what it costs is a duplicate line in a history, which is why
 * there is no guard here of the kind BP-489 gives a status change.
 */
export async function recordLinkChanges(
  taskId: mongoose.Types.ObjectId | string,
  actor: string | null,
  added: { url: string }[],
  removed: { url: string }[]
): Promise<void> {
  for (const link of removed) {
    await logActivity(taskId, actor, "pr_unlinked", "linkedPRs", link.url, "");
  }
  for (const link of added) {
    await logActivity(taskId, actor, "pr_linked", "linkedPRs", "", link.url);
  }
}

/**
 * The update that rewrites one provider's links on a task and leaves the other provider's alone.
 *
 * An aggregation pipeline rather than a read-mutate-save, because two syncs of the same task
 * overlap easily — a scheduled one against a double-clicked manual one — and the later `save()`
 * silently dropped whatever the earlier had added (BP-559).
 *
 * `$filter` keeps two kinds of link: the other provider's, and this provider's own links whose url
 * this round never saw. `docs` is what the round did see for this task. Before BP-617 the second
 * kind was dropped, so a task holding an older pull request lost it the moment a newer one
 * appeared — silently, on an ordinary project, with no rename or repoint needed.
 *
 * `?? "github"` in reverse: a link stored before the provider field existed is GitHub's, so a
 * GitHub sync owns it rather than leaving it beside its own replacement.
 *
 * A link stored without a `url` at all — a shape the schema forbids and only the two syncs write —
 * is kept, because a missing field is not one of the strings in `seen`. That is a fact about
 * MongoDB rather than about this expression, and `e2e/pr-link-replacement.spec.ts` pins the
 * outcome; an `$ifNull` guard written here first was removed after the database showed it changed
 * nothing. Nothing reproduces that measurement now — the test holds "kept", not "the guard was
 * redundant" (found in review).
 *
 * Mongoose does not cast a pipeline update, so `docs` must already hold real `Date`s.
 */
export function replaceProviderLinks(
  provider: "github" | "gitlab",
  docs: unknown[],
  seen: string[]
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
                    { $not: [{ $in: ["$$this.url", seen] }] },
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
 * `seen` is every pull request this round's fetch returned, matched or not — the round's whole
 * field of view, not this task's share of it. That is what makes a removal a fact.
 */
export async function writeProviderLinks(
  taskId: mongoose.Types.ObjectId,
  provider: "github" | "gitlab",
  docs: (Record<string, unknown> & { _id?: never })[],
  seen: string[]
): Promise<void> {
  const withIds = docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  await Task.updateOne({ _id: taskId }, replaceProviderLinks(provider, withIds, seen), {
    updatePipeline: true,
    // `updatedAt` means "when somebody changed this task", and a sync is not somebody. Mongoose
    // stamps a pipeline update like any other unless told not to, and `stats/route.ts:70,147`
    // reads a **done** task's `updatedAt` as the day it was finished — so tidying a stale badge
    // off a task finished last quarter moved it onto this week's chart, and the detail read
    // "Edited just now" on a task nobody had edited (BP-627).
    //
    // Both writes, not only the removal pass — and the churn BP-443's `unchanged()` removed is not
    // the reason, because after it the first loop also writes only when something genuinely
    // changed. The reason is the same screen reached by a different door: a done task whose merged
    // pull request's badge changes — a late CI re-run, a check an app posts hours after the merge —
    // is written by the first loop, with no removal involved at all.
    //
    // The reading that would justify stamping — "a badge appearing is a visible change, so
    // `recently updated` should surface it" — is an argument about the board filter and the My
    // Tasks sort, where being wrong costs a card not jumping to the top. `stats` is the reader
    // where being wrong produces a false number.
    //
    // What replaces it is `recordLinkChanges` above: an activity row, which is a trace on the task
    // that no reader of `updatedAt` can mistake for somebody editing it (BP-628).
    timestamps: false,
  });
}
