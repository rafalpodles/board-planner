/**
 * Answers the task form's AI Assist with the one draft the documentation shows: a CSV export that
 * duplicates ORB-4 and waits on it. Point the app at it with OPENAI_BASE_URL — see demo.ts.
 *
 *   npx tsx scripts/docs-screens/ai-stub.ts
 */

import { createServer } from "node:http";

const PORT = Number(process.env.AI_STUB_PORT ?? 3616);

const DRAFT = {
  title: "Let customers export their invoice history as CSV",
  description:
    "Add an **Export CSV** action to the invoice history, so a customer can hand their billing records to an accountant without copying rows by hand. One row per invoice: number, date, amount, currency, status.",
  category: "user-story",
  acceptanceCriteria: [
    "The invoice history offers Export CSV",
    "The file has one row per invoice with number, date, amount, currency and status",
    "Amounts use the invoice's own currency, not the account default",
  ].join("\n"),
  fields: { Difficulty: "M" },
  duplicateOf: 4,
  duplicateReason:
    "ORB-4 already adds a billing tab that lists invoice history — the export probably belongs inside that work rather than beside it.",
  suggestedBlockedBy: [4],
  suggestedBlocking: [],
  dependencyReason: "The export lives in the billing tab, so ORB-4 has to land before there is anywhere to put it.",
};

createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-docs",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o-mini",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(DRAFT) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    );
  });
}).listen(PORT, "127.0.0.1", () => console.log(`AI Assist stub on http://127.0.0.1:${PORT}/v1`));
