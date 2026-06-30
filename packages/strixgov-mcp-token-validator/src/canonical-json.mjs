/**
 * Strix Canonical JSON (SCJ) v1 — vendored reference implementation.
 *
 * Byte-identical to `solo-builder-core/src/canonical-json.ts`. The
 * validator vendors this rather than depending on solo-builder-core to
 * preserve the zero-Strix-runtime-dependency property — the validator's
 * trust path must not require any Strix-published service to be up,
 * honest, or reachable.
 *
 * A canonical-JSON parity test (`test/canonical-json-parity.test.mjs`)
 * pins this implementation against locked golden vectors so drift from
 * the source-of-truth is caught at CI.
 *
 * Spec: docs/architecture/canonical-json.md (contractVersion 1.0.0)
 * Invariant: CJ-1
 *
 * Summary of rules (see spec for full detail):
 *  - object keys are byte-sorted at every nesting level
 *  - arrays preserve insertion order
 *  - numbers are shortest round-trippable IEEE-754 decimal
 *  - no whitespace, no trailing newline
 *  - no NaN, ±Infinity, undefined, -0, duplicate keys
 *  - strings are UTF-8 with the JSON-standard escape set; non-ASCII
 *    printable characters appear literally
 *
 * Do not re-implement. If you find yourself needing a variant, that is
 * an SCJ v2 conversation (new gate report), not an inline edit here.
 */

import { createHash } from "node:crypto";

export const CANONICAL_JSON_ERRORS = Object.freeze({
  UNDEFINED: "CANONICAL_JSON_UNDEFINED",
  UNDEFINED_FIELD: "CANONICAL_JSON_UNDEFINED_FIELD",
  NON_FINITE_NUMBER: "CANONICAL_JSON_NON_FINITE_NUMBER",
  NEGATIVE_ZERO: "CANONICAL_JSON_NEGATIVE_ZERO",
  INVALID_TYPE: "CANONICAL_JSON_INVALID_TYPE",
});

export class CanonicalJsonError extends Error {
  constructor(code, pathStr, detail) {
    super(`${code} at ${pathStr || "$"}${detail ? ": " + detail : ""}`);
    this.code = code;
    this.pathStr = pathStr;
    this.name = "CanonicalJsonError";
  }
}

export function canonicalizeJSON(value) {
  return serialize(value, "");
}

export function sha256OfJSON(value) {
  const canonical = canonicalizeJSON(value);
  return "sha256:" + createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export const SCJ_VERSION = "scj-v1";

// ── internal ─────────────────────────────────────────────────────────

function serialize(value, path) {
  if (value === undefined) {
    throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.UNDEFINED, path);
  }
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        CANONICAL_JSON_ERRORS.NON_FINITE_NUMBER,
        path,
        String(value),
      );
    }
    if (Object.is(value, -0)) {
      throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.NEGATIVE_ZERO, path);
    }
    return JSON.stringify(value);
  }

  if (t === "string") {
    return JSON.stringify(value);
  }

  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.INVALID_TYPE, path, t);
  }

  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(serialize(value[i], path + "[" + i + "]"));
    }
    return "[" + parts.join(",") + "]";
  }

  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(
        CANONICAL_JSON_ERRORS.INVALID_TYPE,
        path,
        proto?.constructor?.name || "non-plain-object",
      );
    }
    // Default Array.sort() on strings compares UTF-16 code units, which matches SCJ v1 §1.
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) {
        throw new CanonicalJsonError(
          CANONICAL_JSON_ERRORS.UNDEFINED_FIELD,
          path + "." + k,
        );
      }
      parts.push(JSON.stringify(k) + ":" + serialize(v, path + "." + k));
    }
    return "{" + parts.join(",") + "}";
  }

  throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.INVALID_TYPE, path, t);
}
