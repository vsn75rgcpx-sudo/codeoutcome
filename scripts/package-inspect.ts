import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
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
const manifest = JSON.parse(manifestText) as {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  repository?: { url?: unknown };
  publishConfig?: { access?: unknown; tag?: unknown };
  os?: unknown;
};
if (
  manifest.name !== "codeoutcome" ||
  manifest.version !== CODEOUTCOME_VERSION ||
  manifest.private === true ||
  manifest.repository?.url !==
    "git+https://github.com/vsn75rgcpx-sudo/codeoutcome.git" ||
  manifest.publishConfig?.access !== "public" ||
  manifest.publishConfig.tag !== "latest" ||
  !Array.isArray(manifest.os) ||
  manifest.os.join(",") !== "darwin,linux"
) {
  throw new Error("Package publication metadata is incomplete or unsafe");
}
const combinedText = `${cli}\n${manifestText}\n${await readFile("README.md", "utf8")}`;
const normalizedCombinedText = combinedText.replaceAll("\\", "/");
const normalizedHome = homedir().replaceAll("\\", "/");
if (
  /\/Users\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(combinedText) ||
  (normalizedHome.length > 1 && normalizedCombinedText.includes(normalizedHome))
) {
  throw new Error("Package contains a local home path or key marker");
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
      publicationMetadata: true,
      forbiddenEntries: 0,
      localPathMarkers: 0,
    },
    null,
    2,
  ),
);
