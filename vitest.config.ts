import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@codeoutcome/shared/dashboard": fromRoot(
        "./packages/shared/src/dashboard.ts",
      ),
      "@codeoutcome/shared": fromRoot("./packages/shared/src/index.ts"),
      "@codeoutcome/core": fromRoot("./packages/core/src/index.ts"),
      "@codeoutcome/adapter-claude-code": fromRoot(
        "./packages/adapters/claude-code/src/index.ts",
      ),
      "@codeoutcome/adapter-codex": fromRoot(
        "./packages/adapters/codex/src/index.ts",
      ),
      "@codeoutcome/database": fromRoot("./packages/database/src/index.ts"),
      "@codeoutcome/git-tracker": fromRoot(
        "./packages/git-tracker/src/index.ts",
      ),
      "@codeoutcome/dashboard-server": fromRoot(
        "./packages/dashboard-server/src/index.ts",
      ),
    },
  },
  test: {
    include: [
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
      "scripts/**/*.test.ts",
    ],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
