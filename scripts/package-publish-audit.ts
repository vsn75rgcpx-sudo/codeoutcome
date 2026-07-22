import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { CODEOUTCOME_VERSION } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);
const tarball = path.resolve(
  `artifacts/package/codeoutcome-${CODEOUTCOME_VERSION}.tgz`,
);
const { stdout, stderr } = await execFileAsync(
  "npm",
  [
    "publish",
    tarball,
    "--dry-run",
    "--access",
    "public",
    "--tag",
    "latest",
    "--registry",
    "https://registry.npmjs.org/",
  ],
  { maxBuffer: 10 * 1024 * 1024 },
);
const output = `${stdout}\n${stderr}`;
if (!output.includes(`codeoutcome@${CODEOUTCOME_VERSION}`)) {
  throw new Error("npm publish dry-run did not report the expected package");
}
console.log(
  JSON.stringify(
    {
      dryRun: true,
      package: `codeoutcome@${CODEOUTCOME_VERSION}`,
      registry: "https://registry.npmjs.org/",
      access: "public",
      tag: "latest",
      published: false,
    },
    null,
    2,
  ),
);
