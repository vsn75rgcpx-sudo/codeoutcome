import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileCheckpoint,
  hashFilePrefix,
  matchesFileCheckpoint,
  streamJsonlRecords,
} from "./index.js";

async function fixture(contents: string | Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-shared-"));
  const file = path.join(directory, "fixture.jsonl");
  await writeFile(file, contents);
  return file;
}

describe("streamJsonlRecords", () => {
  it("preserves byte offsets and retains a truncated trailing record", async () => {
    const first = `${JSON.stringify({ type: "first", text: "世界" })}\n`;
    const file = await fixture(`${first}{"type":"unfinished"`);
    const records: Array<{
      type?: unknown;
      startOffset: number;
      endOffset: number;
    }> = [];
    const result = await streamJsonlRecords(file, 0, (record, position) => {
      records.push({ type: record.type, ...position });
    });

    expect(records).toEqual([
      {
        type: "first",
        startOffset: 0,
        endOffset: Buffer.byteLength(first),
      },
    ]);
    expect(result.processedBytes).toBe(Buffer.byteLength(first));
    expect(result.truncated).toBe(true);
  });

  it("discards an oversized line without retaining it in memory", async () => {
    const valid = `${JSON.stringify({ type: "valid", tokens: 7 })}\n`;
    const file = await fixture(`${"x".repeat(256)}\n${valid}`);
    const records: unknown[] = [];
    const result = await streamJsonlRecords(
      file,
      0,
      (record) => {
        records.push(record);
      },
      { maxLineBytes: 32 },
    );

    expect(records).toEqual([{ type: "valid", tokens: 7 }]);
    expect(result.malformedLines).toBe(1);
    expect(result.processedBytes).toBe(result.fileSize);
    expect(result.truncated).toBe(false);
  });
});

describe("file checkpoints", () => {
  it("verifies an old prefix after a file is appended", async () => {
    const initial = `${JSON.stringify({ tokens: 1 })}\n`;
    const file = await fixture(initial);
    const checkpoint = await createFileCheckpoint(file);
    await appendFile(file, `${JSON.stringify({ tokens: 2 })}\n`);

    await expect(
      matchesFileCheckpoint(file, Buffer.byteLength(initial), checkpoint),
    ).resolves.toBe(true);
  });

  it("detects changed content and accepts legacy full hashes", async () => {
    const file = await fixture("abcdefghij");
    const checkpoint = await createFileCheckpoint(file);
    const legacyHash = await hashFilePrefix(file);
    await expect(matchesFileCheckpoint(file, 10, legacyHash)).resolves.toBe(
      true,
    );

    await writeFile(file, "abcdXfghij");
    await expect(matchesFileCheckpoint(file, 10, checkpoint)).resolves.toBe(
      false,
    );
  });
});
