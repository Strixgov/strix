/**
 * Durable, single-host approval ledger. Exclusive-create consumption is atomic
 * among processes sharing one POSIX filesystem. NOT safe across independent
 * hosts, network filesystems without O_EXCL guarantees, or compromised hosts.
 */
import { mkdir, writeFile, readFile, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { actionDigest } from "./semgrep-pinned.mjs";

function tokenKey(token) {
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}
export class DurableApprovalLedger {
  constructor({ dir }) {
    if (!dir || !dir.startsWith("/")) throw new TypeError("Absolute ledger directory required");
    this.dir = dir;
  }
  async issue({ tenantId, actorId, tool, args, ttlMs = 60000 }) {
    if (!tenantId || !actorId || !tool || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new TypeError("Invalid approval");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const key = tokenKey(token);
    const record = { digest: actionDigest({ tenantId, actorId, tool, args }), expires: Date.now() + ttlMs };
    await writeFile(join(this.dir, key + ".json"), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return token;
  }
  async consume(token, action) {
    const key = tokenKey(token);
    if (!key) return false;
    // Claim first, atomically. Even invalid attempts burn the grant.
    let handle;
    try {
      handle = await open(join(this.dir, key + ".used"), "wx", 0o600);
      await handle.writeFile(new Date().toISOString() + "\n");
      await handle.sync();
    } catch {
      return false; // fail closed on already used or unavailable store
    } finally {
      await handle?.close();
    }
    try {
      const record = JSON.parse(await readFile(join(this.dir, key + ".json"), "utf8"));
      return Number.isSafeInteger(record.expires) && record.expires > Date.now() &&
        record.digest === actionDigest(action);
    } catch { return false; }
  }
}
