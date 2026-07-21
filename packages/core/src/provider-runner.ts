import { spawn } from "node:child_process";

export type SupportedTerminationSignal = "SIGINT" | "SIGTERM";

export interface ProviderProcessOutcome {
  exitCode: number;
  signal: SupportedTerminationSignal | null;
}

export interface ProviderSpawnOptions {
  shell: false;
  stdio: "inherit";
}

export type ProviderProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: ProviderSpawnOptions,
) => Promise<ProviderProcessOutcome>;

function signalExitCode(signal: SupportedTerminationSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

export const defaultProviderProcessRunner: ProviderProcessRunner = (
  executable,
  arguments_,
  options,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      shell: options.shell,
      stdio: options.stdio,
      env: process.env,
      windowsHide: true,
    });
    let forwardedSignal: SupportedTerminationSignal | null = null;
    const forward = (signal: SupportedTerminationSignal): void => {
      forwardedSignal = signal;
      child.kill(signal);
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      const normalizedSignal =
        signal === "SIGINT" || signal === "SIGTERM" ? signal : forwardedSignal;
      resolve({
        exitCode:
          code ??
          (normalizedSignal === null ? 1 : signalExitCode(normalizedSignal)),
        signal: normalizedSignal,
      });
    });
  });

export interface RunTrackedProviderOptions {
  executable: string;
  arguments: readonly string[];
  startTracking: () => Promise<void>;
  stopTracking: (
    status: "completed" | "interrupted" | "failed",
  ) => Promise<void>;
  processRunner?: ProviderProcessRunner;
  onFinalizationError?: (error: unknown) => void;
}

export async function runTrackedProvider(
  options: RunTrackedProviderOptions,
): Promise<number> {
  await options.startTracking();
  let outcome: ProviderProcessOutcome | null = null;
  let processError: unknown;
  let processFailed = false;
  try {
    outcome = await (options.processRunner ?? defaultProviderProcessRunner)(
      options.executable,
      options.arguments,
      {
        shell: false,
        stdio: "inherit",
      },
    );
  } catch (error) {
    processFailed = true;
    processError = error;
  } finally {
    const status =
      outcome?.signal !== null && outcome?.signal !== undefined
        ? "interrupted"
        : outcome?.exitCode === 0
          ? "completed"
          : "failed";
    try {
      await options.stopTracking(status);
    } catch (finalizationError) {
      options.onFinalizationError?.(finalizationError);
    }
  }
  if (processFailed) {
    throw processError;
  }
  if (outcome === null) {
    throw new Error("Provider process completed without an outcome");
  }
  return outcome.exitCode;
}
