/**
 * Size bounds for the ingestion boundary — v0.1 pilot bounds, named in one
 * place so the wire cap and the extraction cap cannot drift apart.
 *
 * MAX_ARTIFACT_BYTES bounds what arrives on the wire. It is NOT sufficient
 * alone: PDF FlateDecode streams and the DOCX document part are compressed,
 * and a ~200KB file can legally inflate to hundreds of megabytes (a
 * decompression bomb) — proven by probe before this bound existed, when a
 * 204KB DOCX inflated to ~400MB in-process and ingested "successfully".
 * MAX_INFLATED_BYTES is therefore a TOTAL inflated-content budget per
 * artifact, enforced at every inflate call via zlib's own maxOutputLength
 * (the allocation stops at the bound — the bomb never materializes), and
 * exceeding it is a named ARTIFACT_TOO_LARGE refusal, never a truncation:
 * truncated content would be released unscanned-in-part, which is the exact
 * class the extracted-text-is-the-released-artifact rule exists to prevent.
 */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10 MiB on the wire
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024; // 64 MiB total inflated content
