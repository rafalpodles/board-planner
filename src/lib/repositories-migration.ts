import { Types, type mongo } from "mongoose";
import { projectRepositoryUrl, type RepositoryFields } from "./repository";

export interface RepositoriesMigration {
  filled: string[];
  alreadyListed: number;
  noRepository: number;
}

type StoredProject = RepositoryFields & { _id: Types.ObjectId; key?: string; repositories?: unknown[] };

/**
 * BP-986: give every project that names a repository its first `repositories` entry, from the same
 * address the app resolves today. A project already listing one is left alone, so a re-run changes
 * nothing, and `repositoryUrl` stays as it was, so reads that still use it are unaffected.
 */
export async function migrateRepositories(db: mongo.Db, { apply }: { apply: boolean }): Promise<RepositoriesMigration> {
  const result: RepositoriesMigration = { filled: [], alreadyListed: 0, noRepository: 0 };
  const projects = (await db.collection("projects").find({}).toArray()) as unknown as StoredProject[];
  for (const project of projects) {
    if ((project.repositories ?? []).length > 0) {
      result.alreadyListed += 1;
      continue;
    }
    const url = projectRepositoryUrl(project);
    if (!url) {
      result.noRepository += 1;
      continue;
    }
    result.filled.push(`${project.key || project._id}: ${url}`);
    if (apply) {
      await db.collection("projects").updateOne(
        { _id: project._id, $or: [{ repositories: null }, { repositories: { $size: 0 } }] },
        { $set: { repositories: [{ _id: new Types.ObjectId(), url, name: "" }] } }
      );
    }
  }
  return result;
}
