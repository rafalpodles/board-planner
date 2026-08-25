import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Component specs opt into a DOM with `// @vitest-environment happy-dom`,
    // so pure-logic specs keep running in the faster node environment
    // e2e/*.test.ts is the group guard, not a Playwright spec — those end in .spec.ts
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "e2e/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
