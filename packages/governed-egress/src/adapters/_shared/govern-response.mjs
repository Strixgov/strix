/**
 * What the local-mode adapters do with an answer after release, in order:
 *   1. scan it (opt-in, `scanResponse`) — over the tokenized answer;
 *   2. withhold it if the caller asked for that and the scan did not pass;
 *   3. re-identify it (opt-in, `reidentify`) — only if it was not withheld.
 *
 * The release has already happened, so nothing here turns it into a
 * refusal. Evidence appends are loud and non-fatal, like the release's own.
 */
import { prefixedHash, sha256Hex } from '../../artifact/hash.mjs';
import {
  responseScanMode,
  scanModelResponse,
  responseScanEvidenceEntry,
  ResponseScanError,
} from '../../response/scan-response.mjs';
import { reidentifyIfAsked } from './reidentify-response.mjs';
import { syntheticSurfaces } from '../../reidentification/reidentify.mjs';

function appendEvidence(deps, entry) {
  const evidence = deps?.evidence;
  if (!evidence || typeof evidence.append !== 'function') return;
  try {
    evidence.append(entry);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[governed-egress] response evidence write failed:', err?.message);
  }
}

export async function governResponse(input, governed, release, deps) {
  const mode = responseScanMode(input?.scanResponse);
  const hasAnswer = release?.released === true && typeof release.responseText === 'string';
  const out = { response: release?.responseText ?? null };
  let withheld = false;

  if (mode) {
    let report;
    if (!hasAnswer) {
      report = { status: 'not_scanned', reason: 'NO_RESPONSE' };
    } else {
      try {
        report = await scanModelResponse({
          responseText: release.responseText,
          detector: deps?.detector,
          generatedValues: syntheticSurfaces(governed?.reidentification),
        });
      } catch (err) {
        report = { status: 'unavailable', reason: err instanceof ResponseScanError ? err.reasonCode : 'SCAN_FAILED' };
      }
      withheld = mode === 'withhold' && report.status !== 'clean';
      appendEvidence(
        deps,
        responseScanEvidenceEntry(report, {
          actor: input.actor ?? null,
          mode,
          withheld,
          releasedArtifactHash: prefixedHash(sha256Hex(governed.releaseText)),
        }),
      );
    }
    out.responseScan = { mode, withheld, ...report };
    if (withheld) out.response = null;
  }

  if (input?.reidentify === true) {
    if (withheld) {
      out.reidentifiedResponse = null;
      out.reidentification = { error: 'RESPONSE_WITHHELD' };
    } else {
      Object.assign(out, reidentifyIfAsked(input, governed, release, deps));
    }
  }
  return out;
}
