import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agentledger/shared/dashboard": fromRoot(
        "./packages/shared/src/dashboard.ts",
      ),
      "@agentledger/shared": fromRoot("./packages/shared/src/index.ts"),
      "@agentledger/core": fromRoot("./packages/core/src/index.ts"),
      "@agentledger/adapter-claude-code": fromRoot(
        "./packages/adapters/claude-code/src/index.ts",
      ),
      "@agentledger/adapter-codex": fromRoot(
        "./packages/adapters/codex/src/index.ts",
      ),
      "@agentledger/database": fromRoot("./packages/database/src/index.ts"),
      "@agentledger/git-tracker": fromRoot(
        "./packages/git-tracker/src/index.ts",
      ),
      "@agentledger/dashboard-server": fromRoot(
        "./packages/dashboard-server/src/index.ts",
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
