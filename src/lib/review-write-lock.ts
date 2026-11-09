import { reviewTimestamp as calendarTimestamp } from "@/utils/reviewTime";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PROTOCOL = "xense-review-flock-v1";
const ATOMIC_PROTOCOL = "xense-review-flock-v2";
const OWNER = "owner.json";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ReviewWriteLockError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "REVIEW_LOCK_UNAVAILABLE",
  ) {
    super(message);
  }
}

/** Persistent inode: never unlink this file, even when no process holds it. */
async function nativeLease(file: string, timeoutMs: number) {
  let identity;
  try {
    const handle = await fs.open(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o664,
    );
    try {
      identity = await handle.stat({ bigint: true });
      if (!identity.isFile())
        throw new ReviewWriteLockError("Invalid system review lock file", 400);
      // A cooperating server may have a stricter umask and a different UID.
      if ((identity.mode & BigInt(0o777)) !== BigInt(0o664))
        await handle.chmod(0o664);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      ["ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw new ReviewWriteLockError("Invalid system review lock file", 400);
    throw error;
  }
  // --no-fork leaves one tiny shell waiting on stdin. Parent exit closes the
  // pipe and releases the kernel lock; there is no timestamp-based takeover.
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--timeout",
      String(timeoutMs / 1000),
      "--conflict-exit-code",
      "75",
      "--no-fork",
      "--",
      file,
      "sh",
      "-c",
      "printf 'locked\\n'; IFS= read -r release || :",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let acquired = false;
  let finished = false;
  let released = false;
  let stderr = "";
  let stdout = "";
  let processError: Error | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      processError = error;
    });
    child.stdin.on("error", (error) => {
      processError = error;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-64);
      if (!acquired && stdout.includes("locked\n")) {
        acquired = true;
        resolve();
      }
    });
    child.once("close", (code) => {
      finished = true;
      resolveClosed();
      if (!acquired)
        reject(
          new ReviewWriteLockError(
            code === 75
              ? "Review file is busy; another writer is still saving. Retry shortly."
              : "Cannot acquire the system review lock. Install util-linux flock and use a filesystem supporting shared locks. " +
                  (processError?.message ?? stderr.trim()),
            code === 75 ? 409 : 503,
            code === 75 ? "REVIEW_LOCK_BUSY" : "REVIEW_LOCK_UNAVAILABLE",
          ),
        );
    });
  });
  return {
    ino: identity.ino.toString(),
    async verifyHeld() {
      const current = await fs
        .lstat(file, { bigint: true })
        .catch(() => undefined);
      if (
        !current?.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev
      )
        throw new ReviewWriteLockError(
          "Review system lock identity changed; stop writers and investigate before retrying",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      if (finished || child.exitCode !== null || child.signalCode !== null)
        throw new ReviewWriteLockError(
          "Review write lock was lost before commit; retry saving",
          503,
          "REVIEW_LOCK_CHANGED",
        );
    },
    assertHeld() {
      if (finished || child.exitCode !== null || child.signalCode !== null)
        throw new ReviewWriteLockError(
          "Review write lock was lost before commit; retry saving",
          503,
          "REVIEW_LOCK_CHANGED",
        );
    },
    async release() {
      if (!released) {
        released = true;
        child.stdin.end("release\n");
      }
      await closed;
    },
  };
}

/** Publish a complete owned directory atomically; mkdir alone has a crash gap. */
export async function acquireReviewWriteLock(
  target: string,
  timeoutMs = 10_000,
) {
  const native = await nativeLease(target + ".write-lock", timeoutMs);
  const directory = target + ".lock";
  const token = randomUUID();
  const stagedDirectory = directory + ".owner-" + token;
  const stagedOwner = path.join(stagedDirectory, OWNER);
  const linkTarget = path.basename(stagedDirectory);
  const deadline = performance.now() + timeoutMs;
  let staged = false;
  let published = false;
  let attempted = false;
  let waitingForLegacy = false;
  let stagedIdentity: { ino: bigint; dev: bigint } | undefined;
  let stagedOwnerIdentity: { ino: bigint; dev: bigint } | undefined;

  async function readOwner(
    ownerPath: string,
    expected?: { ino: bigint; dev: bigint },
  ) {
    let handle;
    try {
      handle = await fs.open(
        ownerPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size > 4096) return undefined;
      if (expected && (stat.ino !== expected.ino || stat.dev !== expected.dev))
        return undefined;
      const content = await handle.readFile("utf8");
      const after = await handle.stat({ bigint: true });
      if (after.ino !== stat.ino || after.dev !== stat.dev) return undefined;
      return JSON.parse(content);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        ["ENOENT", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  // A killed process can leave a staged or retired sibling after the native
  // lease has been released. Only a complete marker (or an empty marker whose
  // owner was never published) with this lock's inode is safe to reap.
  async function reapOrphanDirectories() {
    let entries;
    try {
      entries = await fs.readdir(path.dirname(directory), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    const base = path.basename(directory);
    for (const entry of entries) {
      const prefix = entry.name.startsWith(base + ".owner-")
        ? base + ".owner-"
        : entry.name.startsWith(base + ".retired-")
          ? base + ".retired-"
          : undefined;
      if (!prefix) continue;
      const token = entry.name.slice(prefix.length);
      if (!UUID_PATTERN.test(token)) continue;
      const candidate = path.join(path.dirname(directory), entry.name);
      try {
        const stat = await fs.lstat(candidate, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const names = await fs.readdir(candidate);
        if (names.length === 0) {
          // A referenced empty owner is unknown, not an unpublished staging
          // directory. Preserve it instead of turning its link into a dangling one.
          if (prefix === base + ".owner-") {
            const visible = await fs
              .readlink(directory)
              .catch((error: NodeJS.ErrnoException) => {
                if (["ENOENT", "EINVAL"].includes(error.code ?? ""))
                  return null;
                throw error;
              });
            if (visible === entry.name) continue;
          }
          const current = await fs.lstat(candidate, { bigint: true });
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.ino !== stat.ino ||
            current.dev !== stat.dev
          )
            continue;
          await native.verifyHeld();
          await fs.rmdir(candidate);
          continue;
        }
        if (names.length !== 1 || names[0] !== OWNER) continue;
        const ownerPath = path.join(candidate, OWNER);
        const ownerStat = await fs.lstat(ownerPath, { bigint: true });
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) continue;
        const owner = await readOwner(ownerPath);
        if (
          !owner ||
          ![PROTOCOL, ATOMIC_PROTOCOL].includes(owner.protocol) ||
          owner.ino !== native.ino ||
          owner.token !== token
        )
          continue;
        const current = await fs.lstat(candidate, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== stat.ino ||
          current.dev !== stat.dev
        )
          continue;
        const currentOwner = await fs.lstat(ownerPath, { bigint: true });
        if (
          !currentOwner.isFile() ||
          currentOwner.isSymbolicLink() ||
          currentOwner.ino !== ownerStat.ino ||
          currentOwner.dev !== ownerStat.dev
        )
          continue;
        if (prefix === base + ".owner-") {
          const visible = await fs
            .readlink(directory)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
          await native.verifyHeld();
          if (visible === entry.name) await fs.unlink(directory);
        }
        await native.verifyHeld();
        await fs.unlink(ownerPath);
        await fs.rmdir(candidate);
      } catch {
        // Cleanup is opportunistic. A malformed, concurrently changed, or
        // temporarily inaccessible orphan must never make the lock unusable.
      }
    }
  }

  async function ownedLink() {
    try {
      const stat = await fs.lstat(directory);
      if (
        !stat.isSymbolicLink() ||
        (await fs.readlink(directory)) !== linkTarget
      )
        return false;
      const ownerDirectory = await fs.lstat(stagedDirectory, { bigint: true });
      if (
        !ownerDirectory.isDirectory() ||
        ownerDirectory.isSymbolicLink() ||
        ownerDirectory.ino !== stagedIdentity?.ino ||
        ownerDirectory.dev !== stagedIdentity.dev
      )
        return false;
      const owner = await readOwner(stagedOwner, stagedOwnerIdentity);
      return (
        owner?.protocol === ATOMIC_PROTOCOL &&
        owner.ino === native.ino &&
        owner.token === token
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function removeStaged() {
    if (!staged) return;
    const directoryStat = await fs.lstat(stagedDirectory, { bigint: true });
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.ino !== stagedIdentity?.ino ||
      directoryStat.dev !== stagedIdentity.dev
    )
      throw new ReviewWriteLockError(
        "Review owner directory changed; recovery is required",
        503,
        "REVIEW_LOCK_CHANGED",
      );
    const ownerStat = await fs
      .lstat(stagedOwner, { bigint: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (ownerStat) {
      const owner = await readOwner(stagedOwner);
      const isOurs =
        ownerStat.isFile() &&
        !ownerStat.isSymbolicLink() &&
        ownerStat.ino === stagedOwnerIdentity?.ino &&
        ownerStat.dev === stagedOwnerIdentity.dev;
      if (
        !isOurs ||
        owner?.protocol !== ATOMIC_PROTOCOL ||
        owner.token !== token ||
        owner.ino !== native.ino
      ) {
        throw new ReviewWriteLockError(
          "Review owner changed; recovery is required",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      }
      await fs.unlink(stagedOwner);
    }
    await fs.rmdir(stagedDirectory);
    staged = false;
  }

  try {
    await native.verifyHeld();
    await reapOrphanDirectories();
    await fs.mkdir(stagedDirectory, { mode: 0o775 });
    staged = true;
    const stagedStat = await fs.lstat(stagedDirectory, { bigint: true });
    stagedIdentity = { ino: stagedStat.ino, dev: stagedStat.dev };
    await fs.writeFile(
      stagedOwner,
      JSON.stringify({
        protocol: ATOMIC_PROTOCOL,
        ino: native.ino,
        token,
      }),
      { flag: "wx", mode: 0o664 },
    );
    const stagedOwnerStat = await fs.lstat(stagedOwner, { bigint: true });
    if (!stagedOwnerStat.isFile() || stagedOwnerStat.isSymbolicLink())
      throw new ReviewWriteLockError("Invalid review owner file", 400);
    stagedOwnerIdentity = {
      ino: stagedOwnerStat.ino,
      dev: stagedOwnerStat.dev,
    };
    // Cooperating servers may use different UIDs/umasks on the shared mount.
    await fs.chmod(stagedOwner, 0o664);
    await fs.chmod(stagedDirectory, 0o2775);
    while (true) {
      await native.verifyHeld();
      if (attempted && performance.now() >= deadline)
        throw new ReviewWriteLockError(
          waitingForLegacy
            ? "Review file is busy with an old-version or unknown writer. Pause all old-version saves before recovering an empty lock; no lock was removed automatically."
            : "Review lock publication could not be confirmed before the deadline; retry shortly",
          409,
          waitingForLegacy ? "REVIEW_LEGACY_LOCK" : "REVIEW_LOCK_BUSY",
        );
      attempted = true;
      waitingForLegacy = false;
      try {
        // Relative targets stay valid when another host mounts the same share
        // at a different absolute path. EEXIST never replaces a legacy owner.
        await fs.symlink(linkTarget, directory, "dir");
        published = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let stat;
      try {
        stat = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        const previousTarget = await fs.readlink(directory);
        // NFS may retry a successful symlink RPC and report EEXIST after its
        // acknowledgement was lost. Never reap our own staged owner and then
        // republish a dangling link to it.
        if (previousTarget === linkTarget) {
          await native.verifyHeld();
          if (!(await ownedLink()))
            throw new ReviewWriteLockError(
              "Published review lock ownership cannot be proven; recovery is required",
              503,
              "REVIEW_LOCK_CHANGED",
            );
          published = true;
          break;
        }
        const prefix = path.basename(directory) + ".owner-";
        const previousToken = previousTarget.slice(prefix.length);
        if (
          !previousTarget.startsWith(prefix) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            previousToken,
          )
        )
          throw new ReviewWriteLockError("Unrecognized review lock link", 400);
        const previousDirectory = path.join(
          path.dirname(directory),
          previousTarget,
        );
        const previousStat = await fs
          .lstat(previousDirectory)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
        if (!previousStat)
          throw new ReviewWriteLockError(
            "Review lock points to a missing owner directory; pause all writers and use dangling-lock recovery",
            503,
            "REVIEW_LOCK_DANGLING",
          );
        const previousOwner = path.join(previousDirectory, OWNER);
        const owner =
          previousStat?.isDirectory() && !previousStat.isSymbolicLink()
            ? await readOwner(previousOwner)
            : undefined;
        if (
          owner?.protocol !== ATOMIC_PROTOCOL ||
          owner.ino !== native.ino ||
          owner.token !== previousToken
        )
          throw new ReviewWriteLockError(
            "Review lock ownership cannot be proven; recovery is required",
            503,
            "REVIEW_LOCK_CHANGED",
          );
        await native.verifyHeld();
        // Remove the compatibility name first, in one atomic operation.
        // A crash during owner cleanup leaves only an unreferenced directory.
        await fs.unlink(directory);
        await fs.unlink(previousOwner);
        await fs.rmdir(previousDirectory);
        continue;
      }
      if (!stat.isDirectory())
        throw new ReviewWriteLockError("Invalid review lock entry", 400);
      const ownerPath = path.join(directory, OWNER);
      const owner = await readOwner(ownerPath);
      if (
        owner?.protocol === PROTOCOL &&
        owner.ino === native.ino &&
        (await fs.readdir(directory)).every((name) => name === OWNER)
      ) {
        // Upgrade a proven v1 orphan by retiring the whole directory atomically.
        // Unlinking owner.json first would recreate the empty-directory gap.
        const retired = directory + ".retired-" + randomUUID();
        await native.verifyHeld();
        await fs.rename(directory, retired);
        await fs.unlink(path.join(retired, OWNER));
        await fs.rmdir(retired);
        continue;
      }
      if (performance.now() >= deadline)
        throw new ReviewWriteLockError(
          "Review file is busy with an old-version or unknown writer. If its empty .lock directory is left behind, pause all old-version saves before recovering it; browsing can continue. No lock was removed automatically.",
          409,
          "REVIEW_LEGACY_LOCK",
        );
      waitingForLegacy = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    // A failed exclusive publication must never remove someone else's lock.
    // If publication succeeded but its acknowledgement was lost, retain the
    // complete marker; the next lease holder can recover it safely.
    if (!published) {
      const own = await ownedLink().catch(() => undefined);
      if (own === false) {
        // Failed owner metadata reads do not prove publication failed. Keep
        // the owner whenever the compatibility link still references it, or
        // the link itself cannot be inspected reliably.
        const visible = await fs
          .readlink(directory)
          .catch((error: NodeJS.ErrnoException) =>
            ["ENOENT", "EINVAL"].includes(error.code ?? "") ? null : undefined,
          );
        if (visible !== undefined && visible !== linkTarget)
          await native
            .verifyHeld()
            .then(removeStaged)
            .catch(() => undefined);
      }
    }
    await native.release();
    throw error;
  }
  let released = false;
  return {
    async assertHeld() {
      await native.verifyHeld();
      if (!(await ownedLink()))
        throw new ReviewWriteLockError(
          "Review lock ownership changed; stop writers and investigate before retrying",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      native.assertHeld();
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await native.verifyHeld();
        if (!(await ownedLink()))
          throw new ReviewWriteLockError(
            "Review lock ownership changed; recovery is required",
            503,
            "REVIEW_LOCK_CHANGED",
          );
        await native.verifyHeld();
        await fs.unlink(directory);
        await removeStaged();
      } finally {
        await native.release();
      }
    },
  };
}

async function backupReviewFile(target: string): Promise<string | undefined> {
  const original = await fs
    .lstat(target)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (!original) return undefined;
  if (!original.isFile() || original.isSymbolicLink())
    throw new ReviewWriteLockError(
      "Recovery requires a regular review file or no original file",
      400,
    );
  const stamp = calendarTimestamp()
    .replace(/[:.]/g, "-")
    .replace("+08-00", "+0800");
  const backup = target + ".backup-" + stamp + "-" + randomUUID();
  await fs.copyFile(target, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

/** Operator-only: ALL writers must already be quiescent, including other hosts. */
export async function recoverDanglingReviewLock(
  target: string,
  timeoutMs = 10_000,
): Promise<{ backup?: string; quarantine: string }> {
  const native = await nativeLease(target + ".write-lock", timeoutMs);
  try {
    const directory = target + ".lock";
    const stat = await fs.lstat(directory, { bigint: true });
    const link = stat.isSymbolicLink() ? await fs.readlink(directory) : "";
    const prefix = path.basename(directory) + ".owner-";
    if (
      !link.startsWith(prefix) ||
      !UUID_PATTERN.test(link.slice(prefix.length))
    )
      throw new ReviewWriteLockError(
        "Recovery only accepts a dangling link to a recognized relative owner directory",
        409,
      );
    const ownerDirectory = path.join(path.dirname(directory), link);
    async function verifyDangling() {
      await native.verifyHeld();
      const current = await fs.lstat(directory, { bigint: true });
      if (
        !current.isSymbolicLink() ||
        current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        (await fs.readlink(directory)) !== link
      )
        throw new ReviewWriteLockError(
          "Lock changed during recovery; no lock was moved",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      const owner = await fs
        .lstat(ownerDirectory)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      if (owner)
        throw new ReviewWriteLockError(
          "Owner directory exists; dangling-lock recovery refused",
          409,
        );
    }
    await verifyDangling();
    const backup = await backupReviewFile(target);
    await verifyDangling();
    // Preserve the original relative link as evidence, without following it.
    const quarantine = directory + ".quarantined-" + randomUUID();
    await fs.rename(directory, quarantine);
    return { backup, quarantine };
  } finally {
    await native.release();
  }
}

/** Operator-only: all old-version saves must already be quiescent. */
export async function recoverLegacyReviewLock(
  target: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const native = await nativeLease(target + ".write-lock", timeoutMs);
  try {
    const directory = target + ".lock";
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.readdir(directory)).length
    )
      throw new ReviewWriteLockError(
        "Recovery only accepts an empty legacy lock directory; no files were removed",
        409,
      );
    const backup = await backupReviewFile(target);
    await native.verifyHeld();
    await fs.rmdir(directory);
    return backup;
  } finally {
    await native.release();
  }
}
