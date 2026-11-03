import { extractPdfText, PdfExtractionError } from './pdf-text.mjs';
import { extractPdfTextWithToUnicode } from './pdf-cmap-text.mjs';

export { PdfExtractionError } from './pdf-text.mjs';

/**
 * Production extraction chain. The legacy parser remains the first path for
 * already-proven fixtures. CID/multibyte PDFs may proceed only when their
 * embedded ToUnicode map resolves every emitted glyph. We never guess.
 * Image-only/scanned PDFs are classified separately so the product can ask
 * for governed OCR instead of pretending they are an unsupported format.
 */
export function extractProductionPdfText(buf) {
  try {
    return extractPdfText(buf);
  } catch (err) {
    if (!(err instanceof PdfExtractionError)) throw err;
    if (err.reasonCode === 'EXTRACTION_UNRELIABLE') {
      const recovered = extractPdfTextWithToUnicode(buf);
      if (recovered) return recovered;
      throw err;
    }
    if (err.reasonCode === 'UNSUPPORTED_ARTIFACT' && /no extractable text operators/i.test(err.message)) {
      throw new PdfExtractionError(
        'OCR_REQUIRED',
        'PDF has no safely extractable text; governed OCR is required before sensitive-data inspection can continue',
      );
    }
    throw err;
  }
}
