import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Phase 2 e2e: a minimal smoke test only (D2). Playwright/browser e2e is a
 * Phase 17 concern.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/e2e/**/*.spec.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});