import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/.cache/**", "**/node_modules/**", "**/dist/**"]
  }
});
