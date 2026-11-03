/**
 * Consistent tokenization — the v0.1 ArtifactTransformer (spec §6).
 *
 * Deliberately tokenization, not deletion: every reference to the SAME
 * entity maps to the SAME token ([PATIENT_001] everywhere "William
 * Sampleton", "Sampleton", "William" appear), so the sanitized document
 * keeps its semantic structure for the model while carrying none of the
 * identifier values.
 *
 * Two fail-closed rules:
 *  - An unmapped detection category REFUSES rather than defaulting to a
 *    nearest prefix or a generic bucket (the assurance-vocabulary rule —
 *    a wrong-but-confident token label in a released document is a
 *    confident false statement).
 *  - transformedCount must equal detectedCount or the transformer throws;
 *    a partially-applied transformation must never reach verification
 *    looking like a complete one.
 */
import { TOKEN_PREFIX } from '../detection/categories.mjs';

export const TRANSFORM_ENGINE = Object.freeze({
  name: 'strix-consistent-tokenizer',
  version: '0.1.0',
});

export class TransformationError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'TransformationError';
    this.reasonCode = reasonCode;
  }
}

function normalizeEntity(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Transform text by replacing every finding with a category token.
 * Findings must be the accepted, non-overlapping set a detector returned.
 *
 * @returns {{ engine, version, detectedCount, transformedCount, text, mappings }}
 *   `mappings` carries { category, token } pairs ONLY — never raw values —
 *   because it feeds UI and evidence surfaces (spec §14 shows category→token).
 *   `restore` is the ONE field that carries original values: token → the
 *   longest surface form seen for that entity. It exists only so the caller
 *   can re-identify a model response; the pipeline hands it back as
 *   `reidentification`, outside `artifact`, and nothing records it.
 */
export function createTokenizingTransformer({ reserveExistingTokens = false } = {}) {
  if (typeof reserveExistingTokens !== 'boolean') {
    throw new TypeError('reserveExistingTokens must be a boolean');
  }
  return createReplacingTransformer({ engine: TRANSFORM_ENGINE, replacementFor: null, reserveExistingTokens });
}

/**
 * `reserveExistingTokens` (opt-in, default off so every existing caller's
 * output is byte-identical): never MINT a token whose exact surface already
 * appears in the source text. The drop-in proxy turns this on because a
 * conversation history can carry a token an earlier, separate request
 * produced (a client that kept tokens instead of restored values). The
 * proxy holds no key between requests, so it cannot know what that literal
 * stands for; minting the same surface for a different value would make
 * re-identification restore one person's value where the model meant
 * another. Reserving the surface keeps the literal opaque: it is left as
 * written, never restored, and a fresh value gets the next free number.
 *
 * The shared engine behind the tokenizer and the synthetic replacer.
 * `replacementFor(category, n, sourceLower)` may return a replacement
 * surface for the n-th entity of a category, or null to use the token.
 * Both paths return `insertedSpans` — the output coordinates of every
 * replacement — so verification can mask exactly what was generated.
 * @internal
 */
export function createReplacingTransformer({ engine, replacementFor, reserveExistingTokens = false }) {
  return {
    engine: { ...engine },
    async transform(text, detection) {
      if (typeof text !== 'string') {
        throw new TransformationError('INVALID_INPUT', 'text must be a string');
      }
      const findings = detection?.findings;
      if (!Array.isArray(findings)) {
        throw new TransformationError('INVALID_INPUT', 'detection.findings must be an array');
      }
      const sourceLower = text.toLowerCase();

      const registry = new Map(); // `${category}|${entityKey}` -> { surface, kind }
      const counters = new Map(); // prefix -> next number
      const mappings = [];
      const restore = new Map(); // surface -> { category, value, kind }

      const replacementForFinding = (finding) => {
        const prefix = TOKEN_PREFIX[finding.category];
        if (prefix === undefined) {
          // Total-map refusal: an unknown category must fail, never bucket.
          throw new TransformationError(
            'UNKNOWN_CATEGORY',
            `no token mapping for detection category ${String(finding.category)}`,
          );
        }
        const key = `${finding.category}|${finding.entityKey ?? normalizeEntity(finding.value)}`;
        const existing = registry.get(key);
        if (existing !== undefined) return existing;
        let n = (counters.get(prefix) ?? 0) + 1;
        const tokenSurface = (k) => `[${prefix}_${String(k).padStart(3, '0')}]`;
        if (reserveExistingTokens) {
          while (text.includes(tokenSurface(n))) n += 1;
        }
        counters.set(prefix, n);
        const synthetic = replacementFor ? replacementFor(finding.category, n, sourceLower) : null;
        const entry = synthetic
          ? { surface: synthetic, kind: 'synthetic' }
          : { surface: tokenSurface(n), kind: 'token' };
        registry.set(key, entry);
        mappings.push(
          replacementFor
            ? { category: finding.category, token: entry.surface, kind: entry.kind }
            : { category: finding.category, token: entry.surface },
        );
        return entry;
      };

      const sorted = [...findings].sort((a, b) => a.start - b.start);
      let out = '';
      let cursor = 0;
      let transformedCount = 0;
      const insertedSpans = [];
      for (const f of sorted) {
        if (
          !Number.isInteger(f.start) || !Number.isInteger(f.end) ||
          f.start < cursor || f.end > text.length || f.end <= f.start
        ) {
          throw new TransformationError(
            'OVERLAPPING_FINDINGS',
            'findings must be in-bounds and non-overlapping',
          );
        }
        out += text.slice(cursor, f.start);
        const { surface, kind } = replacementForFinding(f);
        insertedSpans.push({ start: out.length, end: out.length + surface.length, kind });
        out += surface;
        const original = text.slice(f.start, f.end);
        const prev = restore.get(surface);
        if (!prev || original.length > prev.value.length) {
          restore.set(surface, { category: f.category, value: original, kind });
        }
        cursor = f.end;
        transformedCount += 1;
      }
      out += text.slice(cursor);

      if (transformedCount !== findings.length) {
        throw new TransformationError(
          'INCOMPLETE_TRANSFORMATION',
          `transformed ${transformedCount} of ${findings.length} findings`,
        );
      }

      return {
        engine: engine.name,
        version: engine.version,
        detectedCount: findings.length,
        transformedCount,
        text: out,
        mappings,
        insertedSpans,
        restore: [...restore].map(([token, r]) =>
          replacementFor
            ? { token, category: r.category, value: r.value, kind: r.kind }
            : { token, category: r.category, value: r.value },
        ),
      };
    },
  };
}
