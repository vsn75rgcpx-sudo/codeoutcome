import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CODEOUTCOME_VERSION } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-package-"));
const home = path.join(directory, "home");
const data = path.join(directory, "data");
const claude = path.join(directory, "claude-logs");
const codex = path.join(directory, "codex-logs");
const tarball = path.resolve(
  `artifacts/package/codeoutcome-${CODEOUTCOME_VERSION}.tgz`,
);

async function run(
  file: string,
  arguments_: string[],
  allowNonzero = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(file, arguments_, {
      cwd: directory,
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; code?: number };
    if (!allowNonzero) throw error;
    return {
      stdout: detail.stdout ?? "",
      stderr: detail.stderr ?? "",
      code: detail.code ?? 1,
    };
  }
}

await Promise.all(
  [home, data, claude, codex].map((target) =>
    mkdir(target, { recursive: true }),
  ),
);
const environment = {
  ...process.env,
  HOME: home,
  CODEOUTCOME_DATA_DIR: data,
  CODEOUTCOME_CLAUDE_LOG_DIR: claude,
  CODEOUTCOME_CODEX_LOG_DIR: codex,
  NODE_PATH: "",
  NO_UPDATE_NOTIFIER: "1",
};

try {
  await writeFile(
    path.join(directory, "package.json"),
    '{"name":"codeoutcome-package-smoke","private":true}\n',
  );
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
  const binary = path.join(directory, "node_modules/.bin/codeoutcome");
  const help = await run(binary, ["--help"]);
  const version = await run(binary, ["--version"]);
  const doctor = await run(binary, ["doctor", "--provider", "codex", "--json"]);
  const doctorReport = JSON.parse(doctor.stdout) as {
    summary?: { fail?: number };
  };
  const formats = await run(binary, [
    "formats",
    "--provider",
    "codex",
    "--json",
  ]);
  const formatReport = JSON.parse(formats.stdout) as {
    formats?: Array<{ validation?: string }>;
  };
  const feedback = await run(binary, ["feedback", "--json"]);
  const feedbackReport = JSON.parse(feedback.stdout) as {
    sent?: boolean;
    automaticCollection?: boolean;
  };
  await run(binary, ["import", "--provider", "all"]);
  const testRun = await run(binary, [
    "test",
    process.execPath,
    "-e",
    "process.exit(0)",
  ]);

  const child = spawn(
    binary,
    ["dashboard", "--no-open", "--port", "0", "--json"],
    {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const dashboardUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Dashboard start timed out")),
      15_000,
    );
    const check = (): void => {
      const match = /"url":\s*"([^"]+)"/.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Dashboard exited early (${code}): ${stderr}`));
    });
  });
  const homeResponse = await fetch(dashboardUrl);
  const html = await homeResponse.text();
  const token = /name="codeoutcome-dashboard-token"\s+content="([^"]+)"/.exec(
    html,
  )?.[1];
  if (
    !homeResponse.ok ||
    token === undefined ||
    !html.includes('<div id="root">')
  ) {
    throw new Error("Installed package did not serve its Dashboard homepage");
  }
  const health = await fetch(new URL("/api/health", dashboardUrl), {
    headers: { "x-codeoutcome-dashboard-token": token },
  });
  const healthBody = (await health.json()) as {
    data?: { status?: string };
  };
  if (!health.ok || healthBody.data?.status !== "ok") {
    throw new Error("Installed package Dashboard health check failed");
  }
  child.kill("SIGINT");
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Dashboard did not stop after SIGINT"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  await run("npm", [
    "uninstall",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "codeoutcome",
  ]);

  console.log(
    JSON.stringify(
      {
        installedOutsideMonorepo: true,
        version: version.stdout.trim(),
        help: help.stdout.includes("codeoutcome doctor"),
        doctorFailCount: doctorReport.summary?.fail ?? null,
        codexFormatValidation:
          formatReport.formats?.[0]?.validation ?? "missing",
        feedbackSent: feedbackReport.sent ?? null,
        feedbackAutomaticCollection: feedbackReport.automaticCollection ?? null,
        simplifiedTestCommand: testRun.stdout.includes("Status/outcome"),
        dashboardHomepage: homeResponse.status,
        dashboardHealth: health.status,
        stoppedCleanly: true,
        uninstalled: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
