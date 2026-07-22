import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const staging = path.resolve("artifacts/package/codeoutcome");
const destination = path.resolve("artifacts/package");
await execFileAsync(
  "pnpm",
  ["pack", "--dry-run", "--pack-destination", destination],
  {
    cwd: staging,
    maxBuffer: 10 * 1024 * 1024,
  },
);
const { stdout } = await execFileAsync(
  "pnpm",
  ["pack", "--pack-destination", destination],
  { cwd: staging, maxBuffer: 10 * 1024 * 1024 },
);
process.stdout.write(stdout);
