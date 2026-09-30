#!/usr/bin/env node
// Dumps the latest LocalAgentJob (result, execution log, DOM evidence) to
// last-agent-job.json so it can be attached to the chat for debugging.
// Run from the repo root:  node scripts/dump-agent-job.cjs

const fs = require("fs");
const path = require("path");

(function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

async function main() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const job = await prisma.localAgentJob.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (!job) {
      console.log("No LocalAgentJob rows found in the database.");
      return;
    }
    const out = path.join(process.cwd(), "last-agent-job.json");
    fs.writeFileSync(out, JSON.stringify(job, null, 2), "utf8");

    console.log("Saved full job row to:");
    console.log("  " + out);
    console.log("");
    console.log("id:        " + job.id);
    console.log("type:      " + job.jobType);
    console.log("status:    " + job.status);
    console.log("createdAt: " + job.createdAt?.toISOString?.());
    if (job.errorMessage) console.log("error:     " + job.errorMessage);
    if (job.pauseMessage) console.log("pause:     " + job.pauseMessage);
    if (job.pauseAction) console.log("pauseAction: " + job.pauseAction);

    let logs = [];
    try {
      logs = JSON.parse(job.logsJson || "[]");
    } catch (e) {}
    console.log("");
    console.log("executionLog entries: " + logs.length + "  (last 15 below)");
    for (const l of logs.slice(-15)) {
      console.log(
        "  - " + String(l.step || "") + " | " + String(l.label || "") + " | " + String(l.detail || "").slice(0, 160),
      );
    }

    try {
      const r = JSON.parse(job.resultJson || "{}");
      console.log("");
      console.log("result keys: " + Object.keys(r).join(", "));
      if (Array.isArray(r.domEvidence)) {
        console.log("domEvidence elements: " + r.domEvidence.length);
      }
    } catch (e) {}

    console.log("");
    console.log("=> Attach this file to the chat: last-agent-job.json");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});