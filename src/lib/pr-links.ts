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
            docs,
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
  docs: Record<string, unknown>[]
): Promise<void> {
  const withIds = docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  await Task.updateOne({ _id: taskId }, replaceProviderLinks(provider, withIds), {
    updatePipeline: true,
  });
}
