import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import {
  asRecord,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  streamJsonlRecords,
} from "../packages/shared/src/index.js";

const directory = await mkdtemp(path.join(tmpdir(), "codeoutcome-large-log-"));
const sourceFile = path.join(directory, "large-session.jsonl");
const writer = createWriteStream(sourceFile, { encoding: "utf8" });

async function writeLine(value: unknown): Promise<void> {
  if (!writer.write(`${JSON.stringify(value)}\n`)) await once(writer, "drain");
}

try {
  await writeLine({
    type: "session_meta",
    timestamp: "2026-07-22T00:00:00.000Z",
    payload: { id: "synthetic-large-log" },
  });
  const privateBody = "x".repeat(8 * 1024);
  for (let index = 0; index < 4096; index += 1) {
    await writeLine({
      type: "response_item",
      timestamp: "2026-07-22T00:00:01.000Z",
      payload: { content: privateBody },
    });
  }
  await writeLine({
    type: "oversized-unknown",
    payload: { content: "x".repeat(DEFAULT_MAX_JSONL_LINE_BYTES + 1024) },
  });
  await writeLine({
    type: "event_msg",
    timestamp: "2026-07-22T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 12,
        },
      },
    },
  });
  writer.end();
  await once(writer, "finish");

  const started = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let records = 0;
  const parsed = await streamJsonlRecords(sourceFile, 0, (record) => {
    records += 1;
    const payload = asRecord(record.payload);
    const info = asRecord(payload?.info);
    const usage = asRecord(info?.total_token_usage);
    if (typeof usage?.input_tokens === "number") {
      inputTokens = usage.input_tokens;
    }
    if (typeof usage?.output_tokens === "number") {
      outputTokens = usage.output_tokens;
    }
  });
  const elapsedMs = Math.round(performance.now() - started);
  const metadata = await stat(sourceFile);
  if (
    parsed.processedBytes !== metadata.size ||
    parsed.malformedLines !== 1 ||
    inputTokens !== 120 ||
    outputTokens !== 12
  ) {
    throw new Error(
      `Large synthetic JSONL accounting smoke failed: ${JSON.stringify({
        fileSize: metadata.size,
        processedBytes: parsed.processedBytes,
        malformedLines: parsed.malformedLines,
        inputTokens,
        outputTokens,
      })}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        bytes: metadata.size,
        mebibytes: Number((metadata.size / (1024 * 1024)).toFixed(1)),
        processedBytes: parsed.processedBytes,
        malformedOversizedLines: parsed.malformedLines,
        parsedRecords: records,
        elapsedMs,
      },
      null,
      2,
    ),
  );
} finally {
  writer.destroy();
  await rm(directory, { recursive: true, force: true });
}
