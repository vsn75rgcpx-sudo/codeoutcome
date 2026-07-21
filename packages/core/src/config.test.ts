import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configFilePath,
  readAgentLedgerConfig,
  setPrivacyMode,
} from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local privacy configuration", () => {
  it("defaults to git-metadata without creating a config file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-config-"));
    temporaryDirectories.push(directory);

    expect(await readAgentLedgerConfig(directory)).toEqual({
      privacy: "git-metadata",
    });
    await expect(
      readFile(configFilePath(directory), "utf8"),
    ).rejects.toBeDefined();
  });

  it("persists strict mode only in the local data directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentledger-config-"));
    temporaryDirectories.push(directory);

    await setPrivacyMode(directory, "strict");
    expect(await readAgentLedgerConfig(directory)).toEqual({
      privacy: "strict",
    });
    expect(
      JSON.parse(await readFile(configFilePath(directory), "utf8")),
    ).toEqual({
      privacy: "strict",
    });
  });
});
