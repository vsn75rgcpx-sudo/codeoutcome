import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CODEOUTCOME_VERSION } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);
const tarball = path.resolve(
  `artifacts/package/codeoutcome-${CODEOUTCOME_VERSION}.tgz`,
);
const { stdout } = await execFileAsync("tar", ["-tzf", tarball], {
  maxBuffer: 10 * 1024 * 1024,
});
const entries = stdout.trim().split("\n").filter(Boolean);
const allowed = [
  "package/apps/cli/dist/",
  "package/apps/dashboard/dist/",
  "package/README.md",
  "package/LICENSE",
  "package/PRIVACY.md",
  "package/CHANGELOG.md",
  "package/package.json",
];
const unexpected = entries.filter(
  (entry) => !allowed.some((prefix) => entry.startsWith(prefix)),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected package entries: ${unexpected.join(", ")}`);
}

const forbidden = entries.filter((entry) =>
  /(?:\.sqlite(?:-wal|-shm)?$|\.db$|\.jsonl$|\.env(?:\.|$)|fixtures|coverage|test-results|playwright|(?:^|\/)src\/|\.(?:ts|tsx|map)$)/i.test(
    entry,
  ),
);
if (forbidden.length > 0) {
  throw new Error(`Forbidden package entries: ${forbidden.join(", ")}`);
}

const { stdout: listing } = await execFileAsync("tar", ["-tvzf", tarball], {
  maxBuffer: 10 * 1024 * 1024,
});
const cliLine = listing
  .split("\n")
  .find((line) => line.endsWith(" package/apps/cli/dist/index.js"));
if (cliLine === undefined || !/^-[rwx-]{2}x/.test(cliLine)) {
  throw new Error("Packaged CLI is not executable");
}
const { stdout: cli } = await execFileAsync(
  "tar",
  ["-xOzf", tarball, "package/apps/cli/dist/index.js"],
  { maxBuffer: 50 * 1024 * 1024 },
);
if (!cli.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("Packaged CLI is missing its shebang");
}
const { stdout: manifestText } = await execFileAsync("tar", [
  "-xOzf",
  tarball,
  "package/package.json",
]);
const combinedText = `${cli}\n${manifestText}\n${await readFile("README.md", "utf8")}`;
if (
  /\/Users\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(combinedText) ||
  combinedText.includes(userInfo().username)
) {
  throw new Error(
    "Package contains a local absolute path, username, or key marker",
  );
}
const obsoleteUserVisibleBrandMarkers = [
  "AgentLedger —",
  "AgentLedger Dashboard",
  "AgentLedger local dashboard",
  '"name": "agentledger"',
  '"agentledger": "apps/cli/dist/index.js"',
];
if (
  obsoleteUserVisibleBrandMarkers.some((marker) =>
    combinedText.includes(marker),
  )
) {
  throw new Error(
    "Package contains the legacy brand outside documented compatibility references",
  );
}
if (
  !entries.some((entry) => entry.endsWith("apps/dashboard/dist/index.html"))
) {
  throw new Error("Dashboard static index is missing from the package");
}
const metadata = await stat(tarball);
console.log(
  JSON.stringify(
    {
      tarball,
      bytes: metadata.size,
      entries: entries.length,
      executable: true,
      shebang: true,
      dashboardAssets: true,
      forbiddenEntries: 0,
      localPathMarkers: 0,
    },
    null,
    2,
  ),
);
