import fs from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { reviewTimestamp } from "../src/utils/reviewTime";
import { readReviewCollection } from "../src/lib/episode-reviews-store";
import {
  recoverDanglingReviewLock,
  recoverLegacyReviewLock,
} from "../src/lib/review-write-lock";

const [browsePath, ...flags] = process.argv.slice(2);
const dangling = flags.includes("--dangling");
const required = dangling ? "--no-writers" : "--no-legacy-writers";
const eventPrefix = dangling ? "dangling_lock" : "empty_lock";
if (
  !browsePath ||
  !flags.includes(required) ||
  flags.some(
    (flag) => ![required, ...(dangling ? ["--dangling"] : [])].includes(flag),
  )
) {
  console.error(
    "Pause the relevant writers on ALL hosts and wait for in-flight writes to finish. Browsing may continue. Empty legacy directory: bun scripts/recover-review-lock.ts <browse-directory> --no-legacy-writers. Dangling owner link (ALL writers paused): bun scripts/recover-review-lock.ts <browse-directory> --dangling --no-writers",
  );
  process.exitCode = 1;
} else {
  let auditPath: string | undefined;
  try {
    const root = await fs.realpath(browsePath);
    await readReviewCollection(root);
    const auditDirectory = path.join(
      root,
      ".xense-viewer",
      "review-diagnostics",
    );
    const created = await fs.mkdir(auditDirectory, {
      recursive: true,
      mode: 0o2775,
    });
    const realAudit = await fs.realpath(auditDirectory);
    if (!realAudit.startsWith(root + path.sep))
      throw new Error("Recovery audit directory escapes browse directory");
    if (created) await fs.chmod(auditDirectory, 0o2775);
    auditPath = path.join(
      auditDirectory,
      "recovery-" + randomUUID() + ".jsonl",
    );
    await fs.writeFile(
      auditPath,
      JSON.stringify({
        at: reviewTimestamp(),
        event: eventPrefix + "_recovery_requested",
        host: hostname(),
        pid: process.pid,
      }) + "\n",
      { flag: "wx", mode: 0o664 },
    );
    await fs.chmod(auditPath, 0o664);
    const target = path.join(root, ".xense-viewer", "episode-reviews.json");
    const result = dangling
      ? await recoverDanglingReviewLock(target)
      : {
          backup: await recoverLegacyReviewLock(target),
          quarantine: undefined,
        };
    const { backup, quarantine } = result;
    await fs.appendFile(
      auditPath,
      JSON.stringify({
        at: reviewTimestamp(),
        event: eventPrefix + "_recovered",
        backup: backup ? path.basename(backup) : null,
        ...(quarantine ? { quarantine: path.basename(quarantine) } : {}),
      }) + "\n",
    );
    if (dangling) {
      console.log("Dangling lock quarantined: " + quarantine);
      console.log(
        backup
          ? "Records backed up to: " + backup
          : "No review file existed; no review file or backup was created.",
      );
    } else
      console.log(
        backup
          ? "Empty legacy lock recovered. Records backed up to: " + backup
          : "Empty legacy lock recovered. No review file existed; no review file or backup was created.",
      );
    console.log(
      "Existing records and unfinished temporary files were not changed. Retry the manual mark in the viewer.",
    );
  } catch (error) {
    if (auditPath)
      await fs
        .appendFile(
          auditPath,
          JSON.stringify({
            at: reviewTimestamp(),
            event: eventPrefix + "_recovery_failed",
            error_code:
              (error as NodeJS.ErrnoException).code ?? "RECOVERY_FAILED",
          }) + "\n",
        )
        .catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
