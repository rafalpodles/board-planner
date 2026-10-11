import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { isManagedModel, MANAGED_MODEL_PROVIDERS } from "@/lib/managed-models";
import { modelsRestricted } from "@/lib/model-keys";
import { savedAiModel } from "@/lib/model-check";
import { listCatalogue } from "@/lib/openrouter-catalogue";

// What the model pickers offer. `restricted`: the key in use is ours, which runs only the allowed providers' models.
// `models` is null when OpenRouter's list could not be read, and the pickers then take a typed name.
export const GET = withAdmin(async (_request, { db }) => {
  await connectDB();
  const [restricted, catalogue, model] = await Promise.all([modelsRestricted(db), listCatalogue(), savedAiModel(db)]);
  return NextResponse.json({
    restricted,
    model,
    models: catalogue && (restricted ? catalogue.filter((m) => isManagedModel(m.id)) : catalogue),
    providers: restricted ? MANAGED_MODEL_PROVIDERS.map(({ id, label }) => ({ id, label })) : null,
  });
});
