import path from "node:path";

import { seedDemoDatabase } from "./demo-data.js";

const databaseFile = path.resolve(
  process.argv[2] ?? "artifacts/demo/agentledger.sqlite",
);
const summary = seedDemoDatabase(databaseFile);
console.log(JSON.stringify({ demoData: true, ...summary }, null, 2));
