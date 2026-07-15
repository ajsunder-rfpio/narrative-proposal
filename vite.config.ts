/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// Vite 5 + @vitejs/plugin-react-swc 3.x are pinned in package.json; do not upgrade
// them (Lovable builds against these versions — see CLAUDE.md).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // The two ratified suites: `npm test -- graph` and `npm test -- agents`
    // filter by test-file path, so keep file names carrying those words.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
