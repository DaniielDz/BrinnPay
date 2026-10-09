import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/unit/**/*.spec.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Application source only — tests and config are never counted.
      include: ["app/**", "components/**", "lib/**"],
      exclude: ["**/*.d.ts"],
      // Phase 17 D2 (ratchet): thresholds are the measured baseline rounded
      // down, never above it — see ADR-0034. They only move up.
      // (measured 2026-10-09: statements 95.92%, branches 80.46%)
      thresholds: {
        statements: 95,
        branches: 80,
      },
    },
  },
});