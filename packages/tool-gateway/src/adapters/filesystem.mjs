/**
 * Filesystem adapter — governed file I/O.
 *
 * Read = LOW. Write/append = HIGH. Delete = CRITICAL.
 *
 * Why these levels: a read leaks data; a write corrupts it; a delete
 * destroys recovery options. The default classification mirrors how
 * most teams want their AI agents to behave out of the box. Override
 * the registry locally if your threat model differs.
 */

import fs from "node:fs/promises";

/** @type {Record<string, import("../types.d.ts").ToolCapability>} */
export const fsCapabilities = {
  "filesystem.read": {
    id: "filesystem.read",
    name: "filesystem.read",
    risk: "LOW",
    mode: "READ",
    description: "Read a file from disk.",
  },
  "filesystem.list": {
    id: "filesystem.list",
    name: "filesystem.list",
    risk: "LOW",
    mode: "READ",
    description: "List the contents of a directory.",
  },
  "filesystem.write": {
    id: "filesystem.write",
    name: "filesystem.write",
    risk: "HIGH",
    mode: "WRITE",
    description: "Overwrite or create a file on disk.",
  },
  "filesystem.append": {
    id: "filesystem.append",
    name: "filesystem.append",
    risk: "HIGH",
    mode: "WRITE",
    description: "Append to a file on disk.",
  },
  "filesystem.delete": {
    id: "filesystem.delete",
    name: "filesystem.delete",
    risk: "CRITICAL",
    mode: "WRITE",
    description: "Delete a file or directory.",
  },
};

/**
 * Adapter that wraps `fs` operations behind a Gateway. The agent
 * receives the `governedFs` object instead of `node:fs/promises`; every
 * call goes through `gateway.execute` and produces a signed receipt.
 *
 * @param {import("../gateway.mjs").Gateway} gateway
 * @param {{ actorId?: string, actorRole?: string }} [ctx]
 */
export function governedFs(gateway, ctx = {}) {
  for (const cap of Object.values(fsCapabilities)) {
    gateway.registerCapability(cap);
  }

  const wrap = (capabilityId, action, fn) => {
    return async (...args) => {
      const result = await gateway.execute(
        {
          capabilityId,
          action,
          args,
          actorId: ctx.actorId,
          actorRole: ctx.actorRole,
        },
        async (a) => fn(...a)
      );
      if (!result.ok) {
        const err = new Error(
          `${action} denied: ${result.error?.message ?? "policy denied"}`
        );
        // @ts-expect-error attaching context for downstream handlers
        err.code = result.error?.code ?? "DENIED";
        // @ts-expect-error
        err.receipt = result.receipt;
        throw err;
      }
      return result.result;
    };
  };

  return {
    readFile: wrap("filesystem.read", "fs.readFile", (p, opts) =>
      fs.readFile(p, opts ?? "utf8")
    ),
    readdir: wrap("filesystem.list", "fs.readdir", (p, opts) =>
      fs.readdir(p, opts)
    ),
    writeFile: wrap("filesystem.write", "fs.writeFile", (p, data, opts) =>
      fs.writeFile(p, data, opts)
    ),
    appendFile: wrap("filesystem.append", "fs.appendFile", (p, data, opts) =>
      fs.appendFile(p, data, opts)
    ),
    unlink: wrap("filesystem.delete", "fs.unlink", (p) => fs.unlink(p)),
    rm: wrap("filesystem.delete", "fs.rm", (p, opts) => fs.rm(p, opts)),
  };
}
