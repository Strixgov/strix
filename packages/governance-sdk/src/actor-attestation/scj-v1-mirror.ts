/**
 * SCJ v1 Mirror — AA-1 PR 1C.2
 *
 * Byte-equivalent re-implementation of
 * `solo-builder-core/src/canonical-json.ts`. The SDK cannot hard-import
 * sbc (sbc is a private workspace package not published to npm), so we
 * mirror the canonicalizer here.
 *
 * **Mirror discipline.** The CP-K-001 CJ-1 invariant ("every Strix signer
 * + verifier serializes JSON through SCJ v1; output is byte-identical
 * across runtimes") is enforced at the byte level — every line of this
 * module must produce the exact same output as the sbc reference for the
 * same input. A SDK-side test compares this module against a vendored
 * snapshot of sbc's golden vectors (`tests/golden-vectors/canonical-json/
 * vectors.sha256.lock`).
 *
 * **Why a mirror and not a soft import?** The signer's canonical bytes
 * are the artifact's identity. If the import fails at runtime, the
 * signer falls back to a different serializer — that is a silent CJ-1
 * violation. A mirror with a test that pins it to the reference is
 * strictly safer: the test fails CI if sbc's reference changes, forcing
 * an explicit update here. (Same posture as `isStrictRfc3339Mirror` in
 * `agents/loader.ts`.)
 *
 * This file is mechanically copied from `canonical-json.ts`. Do not
 * "improve" it in isolation — every change must land in lockstep with
 * sbc.
 */

export const CANONICAL_JSON_ERRORS = {
  UNDEFINED: "CANONICAL_JSON_UNDEFINED",
  UNDEFINED_FIELD: "CANONICAL_JSON_UNDEFINED_FIELD",
  NON_FINITE_NUMBER: "CANONICAL_JSON_NON_FINITE_NUMBER",
  NEGATIVE_ZERO: "CANONICAL_JSON_NEGATIVE_ZERO",
  INVALID_TYPE: "CANONICAL_JSON_INVALID_TYPE",
} as const;

export class CanonicalJsonError extends Error {
  readonly code: string;
  readonly pathStr: string;
  constructor(code: string, pathStr: string, detail?: string) {
    super(`${code} at ${pathStr || "$"}${detail ? ": " + detail : ""}`);
    this.code = code;
    this.pathStr = pathStr;
    this.name = "CanonicalJsonError";
  }
}

export const SCJ_VERSION = "scj-v1" as const;

export function canonicalizeJSON(value: unknown): string {
  return serialize(value, "");
}

function serialize(value: unknown, path: string): string {
  if (value === undefined) {
    throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.UNDEFINED, path);
  }
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalJsonError(
        CANONICAL_JSON_ERRORS.NON_FINITE_NUMBER,
        path,
        String(n),
      );
    }
    if (Object.is(n, -0)) {
      throw new CanonicalJsonError(CANONICAL_JSON_ERRORS.NEGATIVE_ZERO, path);
    }
    return JSON.stringify(n);
  }

  if (t === "string") {
    return JSON.stringify(value);
  }

  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new CanonicalJsonError(
      CANONICAL_JSON_ERRORS.INVALID_TYPE,
      path,
      t,
    );
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(serialize(value[i], path + "[" + i + "]"));
    }
    return "[" + parts.join(",") + "]";
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(
        CANONICAL_JSON_ERRORS.INVALID_TYPE,
        path,
        proto?.constructor?.name || "non-plain-object",
      );
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
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
