/**
 * Strict RFC 3339 timestamp validation — vendored from
 * `solo-builder-core/src/rfc3339.ts`. Byte-identical behavior.
 *
 * The validator uses this anywhere a timestamp drives a binding
 * decision (issuedAt, expiresAt). `Date.parse` alone is permissive and
 * produces inconsistent results across runtimes; an authorization token
 * accepted on one runtime and rejected on another would be a Mode 3
 * correctness bug.
 *
 * Reject leap-second representations (`60` in the second-of-minute
 * slot). Cross-runtime parsing of leap-seconds is inconsistent; we
 * prefer binding-determinism over single-second exactness.
 */

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isStrictRfc3339(s) {
  if (typeof s !== "string") return false;
  const m = RFC3339_RE.exec(s);
  if (!m) return false;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const offset = m[8];

  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false; // leap-seconds rejected

  if (offset !== "Z") {
    const offHour = Number(offset.slice(1, 3));
    const offMin = Number(offset.slice(4, 6));
    if (offHour > 23) return false;
    if (offMin > 59) return false;
  }

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  return true;
}

export function parseStrictRfc3339(s) {
  if (!isStrictRfc3339(s)) {
    throw new RangeError(`STRICT_RFC3339_REQUIRED: ${JSON.stringify(s)}`);
  }
  return Date.parse(s);
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}
