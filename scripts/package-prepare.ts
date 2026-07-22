import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CODEOUTCOME_VERSION } from "../packages/shared/src/index.js";

const staging = path.resolve("artifacts/package/codeoutcome");
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, "apps/cli/dist"), { recursive: true });
await mkdir(path.join(staging, "apps/dashboard"), { recursive: true });
await cp(
  path.resolve("apps/dashboard/dist"),
  path.join(staging, "apps/dashboard/dist"),
  { recursive: true },
);

for (const name of [
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "CHANGELOG.md",
] as const) {
  await copyFile(path.resolve(name), path.join(staging, name));
}

const manifest = {
  name: "codeoutcome",
  version: CODEOUTCOME_VERSION,
  description:
    "Local-first Claude Code and OpenAI Codex session accounting and review",
  type: "module",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/vsn75rgcpx-sudo/codeoutcome.git",
  },
  homepage: "https://github.com/vsn75rgcpx-sudo/codeoutcome#readme",
  bugs: { url: "https://github.com/vsn75rgcpx-sudo/codeoutcome/issues" },
  bin: { codeoutcome: "apps/cli/dist/index.js" },
  files: [
    "apps/cli/dist",
    "apps/dashboard/dist",
    "README.md",
    "LICENSE",
    "PRIVACY.md",
    "CHANGELOG.md",
  ],
  engines: { node: ">=22.13" },
  keywords: [
    "claude-code",
    "codex",
    "sqlite",
    "token-accounting",
    "local-first",
  ],
} as const;

await writeFile(
  path.join(staging, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
await chmod(path.join(staging, "apps/cli/dist"), 0o755);
