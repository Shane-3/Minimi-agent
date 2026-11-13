import { defineConfig } from "vitest/config";

// Separate from vite.config.ts because that one roots Vite in web/,
// which would hide the server tests.
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
  },
});
