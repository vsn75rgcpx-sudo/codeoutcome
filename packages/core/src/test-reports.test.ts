import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionDatabase } from "@agentledger/database";
import { afterEach, describe, expect, it } from "vitest";

import {
  importTestReport,
  parseTestReportBuffer,
  TestReportParseError,
} from "./test-reports.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentledger-test-report-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("test report parsing", () => {
  it("parses aggregate JUnit XML without saving case names", () => {
    const xml = Buffer.from(
      '<?xml version="1.0"?><testsuites tests="4" failures="1" errors="0" skipped="1"><testsuite name="redacted" tests="4" failures="1" errors="0" skipped="1"><testcase name="not persisted"/></testsuite></testsuites>',
    );
    const result = parseTestReportBuffer(xml, "junit");
    expect(result).toMatchObject({
      format: "junit",
      totalTests: 4,
      passedTests: 2,
      failedTests: 1,
      skippedTests: 1,
    });
    expect(JSON.stringify(result)).not.toContain("not persisted");
    expect(parseTestReportBuffer(xml, "auto").warnings).toContain(
      "format_detection:testsuite_xml_root",
    );
  });

  it("parses pytest, Jest, and Vitest JSON aggregates", () => {
    expect(
      parseTestReportBuffer(
        Buffer.from(
          JSON.stringify({
            summary: { total: 5, passed: 3, failed: 1, skipped: 1 },
          }),
        ),
        "pytest-json",
      ),
    ).toMatchObject({ framework: "pytest", totalTests: 5, failedTests: 1 });
    const jest = Buffer.from(
      JSON.stringify({
        numTotalTests: 4,
        numPassedTests: 3,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
      }),
    );
    expect(parseTestReportBuffer(jest, "jest-json")).toMatchObject({
      framework: "jest",
      passedTests: 3,
    });
    expect(parseTestReportBuffer(jest, "vitest-json")).toMatchObject({
      framework: "vitest",
      failedTests: 1,
    });
  });

  it.each([
    [
      '<!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite tests="1"></testsuite>',
      "external entity declaration",
    ],
    [
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><testsuite tests="1"></testsuite>',
      "entity expansion",
    ],
  ])("rejects unsafe XML: %s", (xml) => {
    expect(() => parseTestReportBuffer(Buffer.from(xml), "junit")).toThrowError(
      TestReportParseError,
    );
    try {
      parseTestReportBuffer(Buffer.from(xml), "junit");
    } catch (error) {
      expect(error).toMatchObject({ code: "unsafe_xml" });
    }
  });

  it("rejects malformed JSON and reports with no aggregate counts", () => {
    expect(() =>
      parseTestReportBuffer(Buffer.from("{"), "pytest-json"),
    ).toThrowError(/Malformed JSON/);
    expect(() =>
      parseTestReportBuffer(Buffer.from("{}"), "jest-json"),
    ).toThrowError(/aggregate test counts/);
  });

  it("imports reports idempotently and updates one record after a rewrite", async () => {
    const directory = await temporaryDirectory();
    const sourceFile = path.join(directory, "junit.xml");
    const database = new SessionDatabase(
      path.join(directory, "agentledger.sqlite"),
    );
    await writeFile(
      sourceFile,
      '<testsuite tests="2" failures="1" errors="0" skipped="0"></testsuite>',
    );
    const first = await importTestReport({
      database,
      sourceFile,
      format: "junit",
      workingDirectory: directory,
      now: () => new Date("2026-07-21T01:00:00.000Z"),
    });
    const duplicate = await importTestReport({
      database,
      sourceFile,
      format: "junit",
      workingDirectory: directory,
      now: () => new Date("2026-07-21T01:01:00.000Z"),
    });
    expect(first.kind).toBe("inserted");
    expect(duplicate.kind).toBe("unchanged");
    expect(duplicate.testRun.id).toBe(first.testRun.id);
    expect(database.listTestRuns()).toHaveLength(1);

    await writeFile(
      sourceFile,
      '<testsuite tests="2" failures="0" errors="0" skipped="0"></testsuite>',
    );
    const updated = await importTestReport({
      database,
      sourceFile,
      format: "junit",
      workingDirectory: directory,
      now: () => new Date("2026-07-21T01:02:00.000Z"),
    });
    expect(updated.kind).toBe("updated");
    expect(updated.testRun.id).toBe(first.testRun.id);
    expect(updated.testRun).toMatchObject({
      outcome: "passed",
      failedTests: 0,
      passedTests: 2,
    });
    expect(database.listTestRuns()).toHaveLength(1);
    database.close();
  });

  it("rejects oversized reports before reading or mutating the database", async () => {
    const directory = await temporaryDirectory();
    const sourceFile = path.join(directory, "large.json");
    await writeFile(sourceFile, "12345");
    const database = new SessionDatabase(
      path.join(directory, "agentledger.sqlite"),
    );
    await expect(
      importTestReport({
        database,
        sourceFile,
        maximumBytes: 4,
        workingDirectory: directory,
      }),
    ).rejects.toMatchObject({ code: "oversized_report" });
    expect(database.listTestRuns()).toHaveLength(0);
    database.close();
  });

  it("strict privacy stores neither report path nor command arguments", async () => {
    const directory = await temporaryDirectory();
    const sourceFile = path.join(directory, "private-report.json");
    await writeFile(
      sourceFile,
      JSON.stringify({
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      }),
    );
    const database = new SessionDatabase(
      path.join(directory, "agentledger.sqlite"),
    );
    const result = await importTestReport({
      database,
      sourceFile,
      format: "pytest-json",
      privacyMode: "strict",
      workingDirectory: directory,
    });
    expect(result.reportImport.canonicalPath).toMatch(/^strict:[a-f0-9]{64}$/);
    expect(result.testRun.commandDisplay).toBe("report-import");
    expect(JSON.stringify(result)).not.toContain("private-report.json");
    database.close();
  });
});
