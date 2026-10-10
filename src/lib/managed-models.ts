import { APP_NAME } from "./brand";

const OPENAI_SERVED_BY_OPENAI = /^openai\/(?!gpt-oss)/;

/** The AI Assist model setting predates OpenRouter and holds a bare OpenAI name such as `gpt-4o-mini` */
export const openrouterModel = (model: string): string => (model.includes("/") ? model : `openai/${model}`);

// No ":" anywhere: OpenRouter's variant suffixes switch on more than a model, :online a web search by a third party
export function isManagedModel(model: string): boolean {
  return !model.includes(":") && OPENAI_SERVED_BY_OPENAI.test(model);
}

export function unmanagedModelError(model: string): string {
  return `The model ${model} is not available on ${APP_NAME}'s AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), or add your organisation's own OpenRouter key in Settings → AI key.`;
}
