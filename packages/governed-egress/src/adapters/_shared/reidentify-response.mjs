/**
 * Opt-in re-identification for the local-mode adapters.
 *
 * With `input.reidentify === true`, a released answer is returned twice:
 * `response` stays exactly what the provider sent (tokenized), and
 * `reidentifiedResponse` has the original values restored for this caller.
 * The key is bound to the hash of the text actually released, so it cannot be
 * applied to a different release.
 *
 * The release has already happened when this runs, so a re-identification
 * problem never turns it into a refusal: the tokenized answer is still
 * returned, with `reidentification.error` naming why values were not
 * restored. An evidence entry (counts only) is appended when a log is
 * present; a failure to append is loud and changes nothing.
 */
import { prefixedHash, sha256Hex } from '../../artifact/hash.mjs';
import { reidentifyResponse, reidentificationEvidenceEntry, ReidentificationError } from '../../reidentification/reidentify.mjs';

export function reidentifyIfAsked(input, governed, release, deps) {
  if (input?.reidentify !== true) return {};
  if (!release?.released || typeof release.responseText !== 'string') {
    return { reidentifiedResponse: null, reidentification: { error: 'NO_RESPONSE' } };
  }
  if (!governed?.reidentification) {
    // Nothing was tokenized: the answer already reads as written.
    return { reidentifiedResponse: release.responseText, reidentification: { error: null, restoredOccurrences: 0 } };
  }
  let result;
  try {
    result = reidentifyResponse({
      responseText: release.responseText,
      key: governed.reidentification,
      releasedArtifactHash: prefixedHash(sha256Hex(governed.releaseText)),
    });
  } catch (err) {
    const code = err instanceof ReidentificationError ? err.reasonCode : 'REIDENTIFICATION_FAILED';
    return { reidentifiedResponse: null, reidentification: { error: code } };
  }
  const evidence = deps?.evidence;
  if (evidence && typeof evidence.append === 'function') {
    try {
      evidence.append(reidentificationEvidenceEntry(result.report, { actor: input.actor ?? null }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[governed-egress] re-identification evidence write failed:', err?.message);
    }
  }
  return { reidentifiedResponse: result.text, reidentification: { error: null, ...result.report } };
}
