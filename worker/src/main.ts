import { createWorker } from "./wiring.js";

async function main(): Promise<void> {
  const worker = createWorker();
  process.on("SIGTERM", () => worker.shutdown());
  process.on("SIGINT", () => worker.shutdown());
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
