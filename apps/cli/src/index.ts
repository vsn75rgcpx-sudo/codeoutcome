#!/usr/bin/env node

import { homedir } from "node:os";

import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error(message.split(homedir()).join("~"));
    process.exitCode = 1;
  },
);
