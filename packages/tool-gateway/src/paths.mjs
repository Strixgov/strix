/**
 * Path helpers.
 *
 * `expandTilde` resolves a leading `~` / `~/` to the current user's home
 * directory. Node does NOT do this — a `~`-prefixed path handed to fs.* is
 * treated as a literal directory named "~", which silently creates the wrong
 * tree. The gateway accepts user-supplied paths via `STRIX_GATEWAY_HOME` and
 * the `JsonlStorage({ dir })` option, so both boundaries expand tilde first.
 */

import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` or `~/` (and the Windows `~\` form) to the user's home
 * directory. Non-string, empty, or non-tilde inputs are returned unchanged, so
 * this is safe to wrap around any path value.
 *
 * @param {string} p
 * @returns {string}
 */
export function expandTilde(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
