import { chmodSync } from "node:fs";
import path from "node:path";

export default {
  plugins: [
    {
      name: "agentledger-cli-executable",
      closeBundle() {
        chmodSync(
          path.resolve("artifacts/package/agentledger/apps/cli/dist/index.js"),
          0o755,
        );
      },
    },
  ],
  build: {
    target: "node22",
    ssr: true,
    outDir: path.resolve("artifacts/package/agentledger/apps/cli/dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    license: true,
    rolldownOptions: {
      input: path.resolve("apps/cli/src/index.ts"),
      external: [/^node:/],
      output: {
        entryFileNames: "index.js",
        codeSplitting: false,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
};
