import { describe, expect, it } from "vitest";

import {
  detectTestFramework,
  detectTestFrameworkWithReason,
  parseTestOutput,
} from "./test-parsers.js";

describe("test output parsers", () => {
  it("parses successful and failed pytest summaries", () => {
    const success = parseTestOutput(
      "pytest",
      "=== 3 passed, 1 skipped in 0.12s ===",
      0,
    );
    expect(success).toMatchObject({
      outcome: "passed",
      totalTests: 4,
      passedTests: 3,
      failedTests: 0,
      skippedTests: 1,
    });
    const failed = parseTestOutput(
      "pytest",
      "=== 2 failed, 4 passed, 1 error in 1s ===",
      1,
    );
    expect(failed).toMatchObject({
      outcome: "errored",
      totalTests: 7,
      passedTests: 4,
      failedTests: 2,
      erroredTests: 1,
    });
  });

  it("parses Jest and Vitest aggregate lines", () => {
    expect(
      parseTestOutput(
        "jest",
        "Tests: 1 failed, 2 skipped, 3 passed, 6 total",
        1,
      ),
    ).toMatchObject({
      totalTests: 6,
      passedTests: 3,
      failedTests: 1,
      skippedTests: 2,
    });
    expect(
      parseTestOutput(
        "vitest",
        " Tests  1 failed | 3 passed | 1 skipped (5)",
        1,
      ),
    ).toMatchObject({
      totalTests: 5,
      passedTests: 3,
      failedTests: 1,
      skippedTests: 1,
    });
  });

  it("parses Go and Cargo test summaries", () => {
    expect(
      parseTestOutput(
        "go",
        "--- PASS: TestOne\n--- SKIP: TestTwo\n--- FAIL: TestThree",
        1,
      ),
    ).toMatchObject({
      totalTests: 3,
      passedTests: 1,
      failedTests: 1,
      skippedTests: 1,
    });
    expect(
      parseTestOutput(
        "cargo",
        "test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out",
        101,
      ),
    ).toMatchObject({
      totalTests: 4,
      passedTests: 2,
      failedTests: 1,
      skippedTests: 1,
    });
  });

  it("falls back to exit codes without inventing test counts", () => {
    const passed = parseTestOutput("generic", "private failure-like text", 0);
    const errored = parseTestOutput("generic", "private failure-like text", 9);
    expect(passed).toMatchObject({
      outcome: "passed",
      parserStatus: "exit_code_only",
    });
    expect(errored).toMatchObject({
      outcome: "errored",
      parserStatus: "exit_code_only",
    });
    expect(passed.totalTests).toBeNull();
    expect(errored.failedTests).toBeNull();
  });

  it("detects frameworks from executable and arguments without config files", () => {
    expect(detectTestFramework("pytest", ["-q"])).toBe("pytest");
    expect(detectTestFramework("go", ["test", "./..."])).toBe("go");
    expect(detectTestFramework("cargo", ["test"])).toBe("cargo");
    expect(detectTestFramework("pnpm", ["exec", "vitest", "run"])).toBe(
      "vitest",
    );
    expect(detectTestFramework("custom-test", [])).toBe("generic");
    expect(
      detectTestFrameworkWithReason("pnpm", ["exec", "vitest", "run"]),
    ).toEqual({
      framework: "vitest",
      reason: "vitest_explicit_argument_marker",
    });
  });
});
