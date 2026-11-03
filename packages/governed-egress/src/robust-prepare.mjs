import { sha256Hex } from './artifact/hash.mjs';
import { MAX_ARTIFACT_BYTES } from './artifact/limits.mjs';
import { PdfExtractionError } from './artifact/pdf-production-text.mjs';
import { extractPdfTextWithPdfJs } from './artifact/pdfjs-text.mjs';
import { isPdfExtractionStage } from './artifact/pdf-extraction-stages.mjs';
import { governedOcrExtract } from './artifact/governed-ocr.mjs';
import { buildRefusalReceipt } from './evidence/refusal-receipt.mjs';
import { prepareDocumentForEgress as prepareLegacy } from './pipeline.mjs';

function isPdfSource(source) {
  return source && Buffer.isBuffer(source.bytes) && source.bytes.length >= 5 && source.bytes.toString('latin1', 0, 5) === '%PDF-';
}

export function extractionRefusal(primary, artifactBase, engine = 'mozilla-pdfjs') {
  const reasonCode = primary instanceof PdfExtractionError
    ? primary.reasonCode
    : (primary?.reasonCode ?? 'EXTRACTION_FAILED');
  // The STAGE is the one diagnostic a refusal may carry everywhere — receipt,
  // evidence entry, response, log — because it is a member of a closed,
  // content-free set. Anything else is null; never a free string.
  const stage = isPdfExtractionStage(primary?.stage) ? primary.stage : null;
  return {
    outcome: 'DENY',
    reasonCode,
    detail: primary?.message ?? 'production PDF extraction failed',
    artifact: {
      ...artifactBase,
      extraction: {
        engine,
        mode: 'local-in-process',
        outcome: 'refused',
        reasonCode,
        stage,
      },
    },
  };
}

/**
 * Preserve the same refusal contract as the preparation pipeline for failures
 * that occur before extracted text can enter that pipeline. Persist only
 * structured receipt fields; parser detail and source bytes never enter the
 * evidence record. Receipt/evidence failure cannot change the DENY verdict.
 */
export function attachExtractionRefusal(refusal, input) {
  let receipt;
  try {
    receipt = buildRefusalReceipt({
      reasonCode: refusal.reasonCode,
      actor: input.actor ?? null,
      principal: input.principal ?? null,
      artifact: refusal.artifact ?? null,
      extraction: refusal.artifact?.extraction ?? null,
      destination: input.destination ?? null,
      purpose: input.purpose ?? null,
      policy: input.policy ?? null,
    });
  } catch {
    return refusal;
  }

  const evidence = input.deps?.evidence;
  if (evidence && typeof evidence.append === 'function') {
    try {
      evidence.append({
        type: 'egress_refused',
        receiptId: receipt.receiptId,
        reasonCode: receipt.reasonCode,
        actor: receipt.actor,
        actorAuthentication: receipt.actorAuthentication,
        principalMethod: receipt.principal.authenticationMethod,
        principalIdentifies: receipt.principal.identifies,
        principalIdentifiesPerson: receipt.principal.identifiesPerson,
        principalSubject: receipt.principal.subject,
        principalTenantId: receipt.principal.tenantId,
        finding: receipt.finding,
        originalArtifactHash: receipt.originalArtifactHash,
        classification: receipt.classification,
        extraction: receipt.extraction,
        destination: receipt.destination,
        purposeCommitment: receipt.purposeCommitment,
        policyId: receipt.policy.policyId,
        policyVersion: receipt.policy.policyVersion,
        execution: receipt.execution,
        disclosureStatus: receipt.disclosureStatus,
      });
    } catch (err) {
      // The denial is already the strictest outcome. Evidence failure must not
      // convert it into a different refusal or allow continuation.
      // eslint-disable-next-line no-console
      console.error('[governed-egress] extraction refusal evidence write failed:', err?.message);
    }
  }
  return { ...refusal, receipt };
}

export async function prepareDocumentForEgress(input) {
  const source = input?.source;
  if (!isPdfSource(source)) return prepareLegacy(input);

  const bytes = source.bytes;
  const originalHash = sha256Hex(bytes);
  const artifactBase = { originalHash, mimeType: 'application/pdf', sizeBytes: bytes.length, filename: source.filename };
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    return attachExtractionRefusal(
      { outcome: 'DENY', reasonCode: 'ARTIFACT_TOO_LARGE', detail: `exceeds ${MAX_ARTIFACT_BYTES} bytes`, artifact: artifactBase },
      input,
    );
  }

  let text;
  let ocrReport = null;
  try {
    // Extraction owns runtime initialization. Readiness uses the exact same
    // static PDF.js module and asset resolver separately for operator health;
    // it is not a second gate with an independent resolution path.
    text = await extractPdfTextWithPdfJs(bytes);
  } catch (primary) {
    // PDF.js is the production authority for PDF text extraction. A second parser
    // must not reinterpret its uncertainty, runtime failure, OCR requirement, or
    // malformed-document refusal into a different document verdict.
    //
    // The ONE exception is governed OCR, and only for OCR_REQUIRED: PDF.js's
    // own verdict ("no text layer") is what licenses it, PDF.js's own page
    // count bounds it, and every way it can fall short refuses by name. With
    // no engine injected this branch is inert and OCR_REQUIRED stands.
    const ocrEngine = input.deps?.ocr ?? null;
    if (!(primary instanceof PdfExtractionError) || primary.reasonCode !== 'OCR_REQUIRED' || !ocrEngine) {
      return attachExtractionRefusal(extractionRefusal(primary, artifactBase), input);
    }
    try {
      ({ text, report: ocrReport } = await governedOcrExtract(bytes, {
        pageCount: primary.pageCount,
        engine: ocrEngine,
        thresholds: input.deps?.ocrThresholds,
      }));
    } catch (ocrErr) {
      return attachExtractionRefusal(extractionRefusal(ocrErr, artifactBase, 'governed-ocr'), input);
    }
  }

  const result = await prepareLegacy({ ...input, source: { text, filename: source.filename } });
  if (result?.artifact && ocrReport) {
    Object.assign(result.artifact, artifactBase, {
      extraction: { ...ocrReport, outcome: 'extracted', originalArtifactHash: originalHash },
    });
  } else if (result?.artifact) {
    Object.assign(result.artifact, artifactBase, {
      extraction: {
        engine: 'mozilla-pdfjs',
        mode: 'local-in-process',
        outcome: 'extracted',
        extractedTextHash: sha256Hex(text),
        originalArtifactHash: originalHash,
      },
    });
  }
  return result;
}
