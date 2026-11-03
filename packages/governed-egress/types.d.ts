/**
 * Type declarations for @strixgov/governed-egress (v0.1).
 *
 * These mirror the runtime shapes in src/ — the .mjs implementations are
 * authoritative; this file exists so TypeScript consumers get the contract
 * without the package taking a build step.
 */

/* ------------------------------ artifact ------------------------------ */

/** Bare 64-hex sha256 (internal binding form). */
export function sha256Hex(input: string | Uint8Array): string;
/** `sha256:<64-hex>` (wire/display form). Throws unless given a bare hash. */
export function prefixedHash(bareHex: string): string;
export function isBareHash(value: unknown): boolean;

export const SUPPORTED_MIME_TYPES: readonly string[];
export const MAX_ARTIFACT_BYTES: number;

/** Every code ingestArtifact can return; pinned against the source by test/ingest-refusal-codes.test.mjs. */
export type IngestRefusalCode =
  | 'ARTIFACT_TOO_LARGE'
  | 'CSV_AMBIGUOUS_LAYOUT'
  | 'CSV_HEADER_INVALID'
  | 'CSV_MALFORMED'
  | 'CSV_NAME_VALUE_UNRECOGNIZED'
  | 'CSV_RAGGED_ROWS'
  | 'CSV_UNRECOGNIZED_NAME_COLUMN'
  | 'DOCX_AMBIGUOUS_TABLE'
  | 'DOCX_HEADER_INVALID'
  | 'DOCX_HIDDEN_CONTENT'
  | 'DOCX_MALFORMED'
  | 'DOCX_NAME_VALUE_UNRECOGNIZED'
  | 'DOCX_RAGGED_ROWS'
  | 'DOCX_UNRECOGNIZED_NAME_COLUMN'
  | 'DOCX_UNSUPPORTED_CONTENT'
  | 'EMPTY_ARTIFACT'
  | 'ENCRYPTED_ARTIFACT'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_UNRELIABLE'
  | 'MIME_MISMATCH'
  | 'PPTX_AMBIGUOUS_TABLE'
  | 'PPTX_HEADER_INVALID'
  | 'PPTX_HIDDEN_CONTENT'
  | 'PPTX_MALFORMED'
  | 'PPTX_NAME_VALUE_UNRECOGNIZED'
  | 'PPTX_RAGGED_ROWS'
  | 'PPTX_UNRECOGNIZED_NAME_COLUMN'
  | 'PPTX_UNSUPPORTED_CONTENT'
  | 'TABULAR_TEXT_UNDECLARED'
  | 'UNSUPPORTED_ARTIFACT'
  | 'XLSX_AMBIGUOUS_LAYOUT'
  | 'XLSX_FORMULA_UNCACHED'
  | 'XLSX_HEADER_INVALID'
  | 'XLSX_HIDDEN_CONTENT'
  | 'XLSX_MALFORMED'
  | 'XLSX_NAME_VALUE_UNRECOGNIZED'
  | 'XLSX_RAGGED_ROWS'
  | 'XLSX_UNRECOGNIZED_NAME_COLUMN'
  | 'XLSX_UNSUPPORTED_CONTENT';

export interface ArtifactSource {
  text?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  filename?: string;
}

/* -------------------------- PDF extraction stages --------------------- */

/**
 * Substrate stages: the runtime the PDF extractor needs BEFORE it opens a
 * document. Closed set; every `EXTRACTION_UNAVAILABLE` refusal names one.
 */
export type PdfjsSubstrateStage =
  | 'canvas_binding'
  | 'canvas_globals'
  | 'pdfjs_module'
  | 'pdfjs_assets_root'
  | 'pdfjs_assets_cmaps'
  | 'pdfjs_assets_fonts'
  | 'pdfjs_assets_wasm';

/** Document stages: the extractor ran and failed while reading THIS document. */
export type PdfDocumentStage = 'document_open' | 'page_open' | 'page_text';

/** Governed OCR stages: the OCR engine fell short of policy on THIS document. */
export type OcrStage = 'ocr_engine' | 'ocr_page_coverage' | 'ocr_confidence';

export type PdfExtractionStage = PdfjsSubstrateStage | PdfDocumentStage | OcrStage;

/* ------------------------------ Governed OCR --------------------------- */

/** One recognized word. `confidence` is 0..1; `line` groups words into lines. */
export interface OcrWord { text: string; confidence: number; line?: number }
export interface OcrPageResult { pageNumber: number; words: OcrWord[] }

/**
 * A governed OCR engine. `locality` MUST be exactly 'local-in-process' — the
 * engine sees the raw, uninspected document, so an off-host engine is refused
 * (OCR_ENGINE_NOT_LOCAL) before any bytes are handed over.
 */
export interface GovernedOcrEngine {
  id: string;
  version: string;
  locality: 'local-in-process';
  recognize(input: { bytes: Buffer; pageCount: number }): Promise<{ pages: OcrPageResult[] }>;
}

/** Stricter-only: values at or below the built-in floors are ignored. */
export interface OcrThresholds { wordConfidenceFloor?: number; pageMeanConfidenceFloor?: number }

export const OCR_LOCALITY: 'local-in-process';
export const OCR_WORD_CONFIDENCE_FLOOR: number;
export const OCR_PAGE_MEAN_CONFIDENCE_FLOOR: number;
export const OCR_MAX_PAGES: number;
export const OCR_PROVES: 'OCR_ENGINE_MET_POLICY_ONLY';
export const OCR_STAGES: readonly OcrStage[];
export const OCR_REFUSAL_CODES: readonly string[];
export function assertGovernedOcrEngine(engine: unknown): { id: string; version: string };

export const PDFJS_SUBSTRATE_STAGES: readonly PdfjsSubstrateStage[];
export const PDF_DOCUMENT_STAGES: readonly PdfDocumentStage[];
export const PDF_EXTRACTION_STAGES: readonly PdfExtractionStage[];
/** Operator-facing meaning per stage. Static; names mechanisms, never content. */
export const PDF_EXTRACTION_STAGE_MEANING: Readonly<Record<PdfExtractionStage, string>>;
export function isPdfExtractionStage(value: unknown): value is PdfExtractionStage;

/** The functional asset file(s) each traced runtime directory must supply. */
export const REQUIRED_RUNTIME_ASSETS: Readonly<
  Record<'pdfjs_assets_cmaps' | 'pdfjs_assets_fonts' | 'pdfjs_assets_wasm', readonly string[]>
>;

export type PdfjsRuntimeReadiness =
  | {
      ready: true;
      engine: 'mozilla-pdfjs';
      runtime: 'node';
      assets: readonly string[];
      stagesVerified: readonly PdfjsSubstrateStage[];
    }
  | {
      ready: false;
      engine: 'mozilla-pdfjs';
      runtime: 'node';
      reasonCode: 'EXTRACTION_UNAVAILABLE';
      /** The FIRST substrate stage that failed, in dependency order. */
      stage: PdfjsSubstrateStage;
      /** Sanitized mechanism text for logs. May name paths; never persist it on a receipt. */
      detail: string;
    };

/**
 * Prove in THIS process that the production PDF extraction substrate can
 * initialize, naming the failing stage when it cannot. Opens no customer
 * bytes; contacts no provider. `robust-prepare` awaits the throwing form
 * before every PDF extraction on the production path.
 */
export function probePdfjsRuntimeReadiness(deps?: {
  loadRuntime?: () => Promise<unknown>;
  importPdfjs?: () => Promise<unknown>;
  resolvePackageRoot?: () => string;
  assetReadable?: (absolutePath: string) => Promise<void>;
}): Promise<PdfjsRuntimeReadiness>;
export function assertPdfjsRuntimeReady(
  deps?: Parameters<typeof probePdfjsRuntimeReadiness>[0],
): Promise<Extract<PdfjsRuntimeReadiness, { ready: true }>>;

export function ingestArtifact(
  source: ArtifactSource | null | undefined,
):
  | { ok: true; text: string; mimeType: string; sizeBytes: number; originalHash: string }
  | { ok: false; reasonCode: IngestRefusalCode; detail: string };

/* ------------------------------ detection ----------------------------- */

export type DetectionCategory =
  | 'PATIENT_NAME'
  | 'DATE'
  | 'MRN'
  | 'SSN'
  | 'PHONE'
  | 'EMAIL'
  | 'ADDRESS'
  | 'INSURANCE_ID'
  | 'OTHER_ID'
  | 'PAYMENT_CARD'
  | 'FINANCIAL_ACCOUNT'
  | 'TAX_ID';

export const DETECTION_CATEGORIES: readonly DetectionCategory[];
export const TOKEN_PREFIX: Readonly<Record<DetectionCategory, string>>;
export const DETECTOR_INFO: Readonly<{ name: string; version: string }>;

export interface DetectionFinding {
  category: DetectionCategory;
  start: number;
  end: number;
  value: string;
  /** Present on PATIENT_NAME findings; other categories key by normalized value. */
  entityKey?: string;
}

export interface DetectionResult {
  detected: boolean;
  findingsCount: number;
  categories: DetectionCategory[];
  findings: DetectionFinding[];
  detector: { name: string; version: string };
}

/** The replaceable detector seam (spec §5). */
export interface SensitiveDataDetector {
  info?: { name: string; version: string };
  /** True only for a detector that honours `options.seeds` (0.5.0+). */
  acceptsSeeds?: boolean;
  scan(input: string, options?: { seeds?: DetectionSeed[] }): Promise<DetectionResult>;
}

/** A span a detection signal proposed. Categories are closed. */
export interface DetectionSeed {
  category: 'PATIENT_NAME' | 'FINANCIAL_ACCOUNT';
  start: number;
  end: number;
}

export const SEEDABLE_CATEGORIES: readonly ('PATIENT_NAME' | 'FINANCIAL_ACCOUNT')[];
export function acceptSeed(
  text: string,
  seed: DetectionSeed,
): { ok: true; seed: DetectionSeed } | { ok: false; reason: 'EMPTY' | 'NO_LETTER' | 'NO_CAPITAL' | 'COMMON_WORD' | 'TOO_FEW_DIGITS' };

/**
 * An optional, stricter-only source of extra findings (e.g. a local model).
 * It proposes spans and decides nothing; failure refuses the release.
 */
export interface DetectionSignal {
  info: {
    name: string;
    version: string;
    model?: string;
    revision?: string;
    weightsSha256?: string;
    threshold?: number;
    chunk?: { maxWords: number; overlap: number };
  };
  propose(text: string): Promise<{ seeds: DetectionSeed[] }>;
}

/** Identity and counts only — never a value, span, offset or score. */
export interface DetectionSignalReport {
  name: string;
  version: string;
  model?: string;
  revision?: string;
  weightsSha256?: string;
  threshold?: number;
  chunk?: { maxWords: number; overlap: number };
  proposed: number;
  accepted: number;
  rejected: number;
  promptProposed: number;
  promptAccepted: number;
}

export const SIGNAL_WORD_CEILING: number;
/** A signal backed by the self-hosted worker. Checks identity and every span. */
export function createHttpDetectionSignal(options: {
  url: string;
  token: string;
  expected: DetectionSignal['info'] & { model: string; revision: string; weightsSha256: string; threshold: number };
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): DetectionSignal;
export const SIGNAL_DENY_CODES: readonly ('DETECTION_SIGNAL_INPUT_TOO_LARGE' | 'DETECTION_SIGNAL_UNAVAILABLE')[];
export const DEFAULT_SIGNAL_TIMEOUT_MS: number;

export function scanText(text: string, options?: { seeds?: DetectionSeed[] }): DetectionResult;
export function createPatternDetector(): SensitiveDataDetector;

/* ---------------------------- transformation -------------------------- */

export const TRANSFORM_ENGINE: Readonly<{ name: string; version: string }>;

export class TransformationError extends Error {
  reasonCode:
    | 'UNKNOWN_CATEGORY'
    | 'OVERLAPPING_FINDINGS'
    | 'INCOMPLETE_TRANSFORMATION'
    | 'INVALID_INPUT';
}

export interface TransformationResult {
  text: string;
  engine: string;
  version: string;
  detectedCount: number;
  transformedCount: number;
  /** category + token (or generated value) only — never raw values. */
  mappings: Array<{ category: DetectionCategory; token: string; kind?: 'token' | 'synthetic' }>;
  /** Output coordinates of every replacement. */
  insertedSpans?: Array<{ start: number; end: number; kind: 'token' | 'synthetic' }>;
}

/** The replaceable transformer seam (spec §6). */
export interface ArtifactTransformer {
  transform(text: string, detection: Pick<DetectionResult, 'findings'>): Promise<TransformationResult>;
}

export function createTokenizingTransformer(): ArtifactTransformer;

/* ----------------------------- verification --------------------------- */

export const VERIFICATION_PROVES: 'NO_FINDINGS_BY_DETECTOR';
export const VERIFICATION_INFO: Readonly<{ name: string; version: string }>;
/** Does an original value survive in lower-cased release text? See verify.mjs. */
export function containsResidual(haystack: string, needle: string): boolean;

export interface VerificationResult {
  status: 'passed' | 'failed';
  scannedHash: string;
  remainingProhibitedFindings: number;
  residualValueFindings: number;
  proves: typeof VERIFICATION_PROVES;
}

export function verifySanitizedArtifact(input: {
  text: string;
  originalFindings: DetectionFinding[];
  detector: SensitiveDataDetector;
  /** Output spans a synthetic replacer generated; blanked for the rescan only. */
  maskedSpans?: Array<{ start: number; end: number }>;
}): Promise<VerificationResult>;
export function maskSpans(text: string, spans: Array<{ start: number; end: number }>): string;

/* -------------------------------- policy ------------------------------ */

export class PolicyValidationError extends Error {
  reasonCode: string;
}

export interface EgressPolicy {
  policyId: string;
  policyVersion: string;
  dataEgress: {
    externalAI: {
      default: 'deny';
      phi: {
        action: 'deny' | 'sanitize';
        requirePostTransformVerification: boolean;
        failClosed: true;
        /** `synthetic`: fictional names/phones/emails, tokens otherwise. Local mode only. */
        replacement?: 'token' | 'synthetic';
        /** Per-category action; unlisted categories tokenize. There is no `allow`. */
        categories?: Partial<Record<DetectionCategory, 'tokenize' | 'flag' | 'block'>>;
      };
      destinations: Record<
        string,
        { enabled: boolean; allowedData: Array<'deidentified' | 'non_sensitive'> }
      >;
    };
  };
}

export const HEALTHCARE_REFERENCE_POLICY: Readonly<EgressPolicy>;

/**
 * Validates and returns a deep-frozen SNAPSHOT of the policy (changed from
 * `true` after 360 probe A, 2026-09-03): the boundary enforces the returned
 * snapshot, never the caller's live object.
 */
export function validateEgressPolicy(policy: unknown): Readonly<EgressPolicy>;
/** Recursively freeze a plain-data object graph. Returns its argument. */
export function deepFreeze<T>(value: T): Readonly<T>;
export function classificationToDataClass(
  classification: string,
): 'non_sensitive' | 'deidentified' | 'phi' | 'unknown';
export function decideDestination(input: {
  classification: string;
  destination: { provider: string; service?: string };
  policy: EgressPolicy;
}): { eligible: true } | { eligible: false; reasonCode: string; detail: string };

/* ----------------------------- authorization -------------------------- */

export const DEFAULT_AUTHORIZATION_TTL_MS: number;

export interface EgressAuthorization {
  authorizationId: string;
  binding: string;
  artifactHash: string;
  promptHash: string;
  destination: { provider: string; service: string };
  purpose: string;
  issuedAt: string;
  expiresAtMs: number;
  consumedAt?: string;
}

export interface AuthorizationStore {
  put(auth: EgressAuthorization): void;
  get(id: string): EgressAuthorization | null;
  /** Atomic single-use claim; exactly one caller wins. */
  claim(id: string, consumedAtIso: string): boolean;
}

export function createInMemoryAuthorizationStore(): AuthorizationStore;

export function bindingAddress(input: {
  artifactHash: string;
  promptHash: string;
  provider: string;
  service: string;
  purpose: string;
}): string;

export function mintEgressAuthorization(input: {
  store: AuthorizationStore;
  artifactHash: string;
  promptHash: string;
  destination: { provider: string; service: string };
  purpose: string;
  ttlMs?: number;
  now?: () => number;
}): EgressAuthorization;

/* ------------------------------- evidence ----------------------------- */

/**
 * Every appended record is hash-chained: `entryHash` = sha256 over the
 * record's canonical content + `prevHash` ('genesis' for the first).
 */
export interface EvidenceRecord {
  seq: number;
  at: string;
  prevHash: string;
  entryHash: string;
  [key: string]: unknown;
}

export interface EvidenceLog {
  append(entry: Record<string, unknown>): EvidenceRecord;
  list(): EvidenceRecord[];
}

export interface EvidenceSigner {
  /** 'egress-' + first 32 hex of sha256(raw public key). */
  keyId: string;
  publicKeyPem: string;
  /** base64url Ed25519 signature over `${scheme}\n${keyId}\n${entryHash}`. */
  sign(entryHash: string): string;
}

export function createInMemoryEvidenceLog(options?: {
  signer?: Pick<EvidenceSigner, 'keyId' | 'sign'>;
  resume?: { seq: number; headHash: string };
}): EvidenceLog;

export const EVIDENCE_SIGNATURE_SCHEME: 'strix-egress-evidence-ed25519-v1';
export const SIGNED_EVIDENCE_PROVES: 'SIGNED_BY_KEY_HOLDER';

export function createEvidenceSigner(privateKeyPem: string | Buffer): EvidenceSigner;
export function generateEvidenceSigningKey(): { keyId: string; privateKeyPem: string; publicKeyPem: string };
export function evidenceKeyIdOf(publicKey: string | Buffer | import('node:crypto').KeyObject): string;
export function evidenceSigningInput(keyId: string, entryHash: string): Buffer;
export function resumePointOf(
  records: EvidenceRecord[],
  signer?: Pick<EvidenceSigner, 'keyId' | 'publicKeyPem'>,
): { seq: number; headHash: string };

/**
 * `proves` and `completeness` are literal fields. A signature proves the
 * holder of a trusted key recorded these entries and nothing changed since;
 * it never proves the holder was honest, and without an independently
 * obtained `expectedHeadHash` it never proves no records were cut off the end.
 */
export function verifySignedEvidence(
  records: EvidenceRecord[],
  options: { publicKeys: Array<string | Buffer>; expectedHeadHash?: string },
):
  | {
      status: 'VERIFIED';
      valid: true;
      length: number;
      headHash: string;
      keyIds: string[];
      completeness: 'NOT_PROVEN' | 'HEAD_MATCHED';
      proves: 'SIGNED_BY_KEY_HOLDER';
      scheme: 'strix-egress-evidence-ed25519-v1';
    }
  | {
      status: 'INVALID' | 'UNVERIFIABLE';
      valid: false;
      index: number;
      reasonCode:
        | 'EMPTY_LOG' | 'CHAIN_LINK_BROKEN' | 'ENTRY_HASH_MISMATCH' | 'SEQ_GAP'
        | 'UNSIGNED_RECORD' | 'MALFORMED_KEY_ID' | 'MALFORMED_SIGNATURE'
        | 'KEY_NOT_TRUSTED' | 'SIGNATURE_INVALID' | 'HEAD_MISMATCH';
      detail: string;
      completeness: 'NOT_PROVEN';
      proves: 'SIGNED_BY_KEY_HOLDER';
      scheme: 'strix-egress-evidence-ed25519-v1';
    };

/**
 * Re-derives every link of a presented log. `proves` is a literal field:
 * a self-consistent chain proves INTERNAL CONSISTENCY ONLY — the log is
 * unsigned and locally held, so a green chain is never authenticity.
 */
export function verifyEvidenceChain(records: EvidenceRecord[]):
  | { valid: true; length: number; headHash: string; proves: 'INTERNAL_CONSISTENCY_ONLY' }
  | {
      valid: false;
      index: number;
      reasonCode: 'CHAIN_LINK_BROKEN' | 'ENTRY_HASH_MISMATCH' | 'SEQ_GAP';
      detail: string;
      proves: 'INTERNAL_CONSISTENCY_ONLY';
    };

export const RECEIPT_PROVES: 'LOCAL_UNSIGNED_RECORD';

export interface EgressReceipt {
  receiptId: string;
  capability: string;
  decision: 'ALLOW' | 'SANITIZE' | 'DENY';
  reasonCode?: string;
  actor: string | null;
  originalArtifactHash: string | null;
  releasedArtifactHash: string | null;
  promptHash: string | null;
  initialClassification: string;
  classification: string;
  transformation?: { result: 'deidentified'; engine: string; version: string; findings: number; transformed: number };
  verification?: { result: string; remainingProhibitedFindings: number; proves: string };
  detector?: { name: string; version: string };
  destination: { provider: string | null; service: string | null };
  authorizationBinding: string | null;
  execution: 'completed' | 'failed' | 'unknown' | 'not_attempted';
  disclosureStatus: 'disclosed' | 'possibly_disclosed' | 'not_disclosed';
  policy: { policyId: string | null; policyVersion: string | null };
  proves: typeof RECEIPT_PROVES;
  timestamp: string;
}

export function buildEgressReceipt(input: Record<string, unknown>): EgressReceipt;

export type CovenantStatus = 'SATISFIED' | 'BREACHED' | 'NOT_ESTABLISHED';
export declare const COVENANT_TERMS: {
  readonly RELEASES_PASSED_VERIFICATION: 'RELEASES_PASSED_VERIFICATION';
  readonly PHI_TRANSFORMED_BEFORE_RELEASE: 'PHI_TRANSFORMED_BEFORE_RELEASE';
};
export interface CovenantEvidenceRecord {
  covenantRecordVersion: string;
  insuredRef: string;
  covenantRef: string;
  window: { from: string; to: string };
  terms: Array<{ term: string; status: CovenantStatus; reason?: string; examined: number; violations: number }>;
  overall: CovenantStatus;
  derivedFrom: { chain: Record<string, unknown>; facts: Record<string, unknown> | null };
  coverage: { scope: 'GOVERNED_TRAFFIC_ONLY'; ungovernedAiUseObserved: null; notCovered: readonly string[] };
  underwriterDeterminationMade: false;
  proves: 'LOCAL_UNSIGNED_RECORD';
  recordHash: string;
}
/** Derive an underwriting covenant record from the FULL evidence log (from genesis). */
export function buildCovenantEvidenceRecord(input: {
  insuredRef: string;
  covenantRef: string;
  terms: string[];
  windowFrom: string;
  windowTo: string;
  entries: EvidenceRecord[];
}): CovenantEvidenceRecord;
/** Re-derive a record from the log; never trusts its stored verdict or hash. */
export function verifyCovenantRecord(
  record: CovenantEvidenceRecord,
  entries: EvidenceRecord[],
): { agrees: boolean; reasons: string[]; proves: 'INTERNAL_CONSISTENCY_ONLY' };

export const REFUSAL_RECEIPT_PROVES: 'LOCAL_UNSIGNED_REFUSAL_RECORD';

/**
 * A refused egress attempt, recorded at the refusal.
 *
 * `finding` carries the CATEGORY of what was found and structurally cannot
 * carry the value — there is no field for one. There is deliberately no
 * `detail`: the pipeline's refusal details interpolate collaborator error
 * text, which is unbounded and can quote the document.
 *
 * `actorAuthentication` is mandatory and never collapsed into the presence
 * of `actor`: nothing in this package authenticates an actor, so a declared
 * one is `DECLARED_UNVERIFIED` and an absent one is `ABSENT`.
 *
 * `principal` is the other axis — what the boundary's CREDENTIAL proved, as
 * opposed to what the request declared. The two never merge, and a principal
 * naming a person does not upgrade a declared actor. `identifies` and
 * `identifiesPerson` are DERIVED from `authenticationMethod`, so no input
 * can claim `USER` without a session actually having been authenticated.
 */
export type PrincipalIdentifies =
  | 'USER'
  | 'API_KEY'
  | 'SERVICE'
  | 'NONE'
  | 'UNRECOGNIZED';

export type PrincipalAuthenticationMethod =
  | 'session'
  | 'tenant_api_key'
  | 'internal_service_token'
  | 'none'
  | 'unrecognized';

export interface AuthenticatedPrincipal {
  authenticationMethod: PrincipalAuthenticationMethod;
  identifies: PrincipalIdentifies;
  /** Derived, never asserted. Only a session names a person. */
  identifiesPerson: boolean;
  /** The user id or key id. Null wherever the credential names no party. */
  subject: string | null;
  tenantId: string | null;
}

export interface RefusalFinding {
  scope: 'document' | 'prompt' | 'unknown';
  categories: string[];
  count: number | null;
}

export interface EgressRefusalReceipt {
  receiptId: string;
  capability: string;
  decision: 'DENY';
  reasonCode: string;
  actor: string | null;
  actorAuthentication: 'DECLARED_UNVERIFIED' | 'ABSENT';
  principal: AuthenticatedPrincipal;
  finding: RefusalFinding | null;
  originalArtifactHash: string | null;
  classification: string;
  /**
   * Present only on a PDF extraction refusal. `stage` is a member of the
   * CLOSED `PDF_EXTRACTION_STAGES` set — a library, a global, a directory —
   * never a document, a filename or a parser message; the builder maps any
   * other value to null. This is the one diagnostic a refusal carries
   * everywhere, and the reason a deployment missing canvas, PDF.js, CMaps,
   * fonts or WASM can now be told apart from the receipt alone.
   */
  extraction: { engine: string | null; stage: PdfExtractionStage | null } | null;
  destination: { provider: string | null; service: string | null };
  /**
   * `sha256:<hex>` over the caller's purpose, or null. The raw purpose is
   * deliberately NOT persisted (caller-supplied free text). This field was
   * declared `purpose: string | null` while the builder has emitted
   * `purposeCommitment` since the receipt was introduced — corrected 2026-09-17.
   */
  purposeCommitment: string | null;
  policy: { policyId: string | null; policyVersion: string | null };
  /** Structural literals: this receipt exists only on the pre-transmission path. */
  execution: 'not_attempted';
  disclosureStatus: 'not_disclosed';
  proves: typeof REFUSAL_RECEIPT_PROVES;
  timestamp: string;
}

export function buildRefusalReceipt(input: {
  capability?: string;
  reasonCode: string;
  actor?: string | null;
  finding?: { scope?: string; categories?: string[]; count?: number } | null;
  artifact?: GovernedArtifact | null;
  destination?: { provider?: string; service?: string } | null;
  purpose?: string | null;
  policy?: { policyId?: string; policyVersion?: string } | null;
  principal?: {
    authenticationMethod?: string;
    subject?: string | null;
    tenantId?: string | null;
  } | null;
}): EgressRefusalReceipt;

export function normalizeCategories(categories: unknown): string[];

export function normalizePrincipal(principal: unknown): AuthenticatedPrincipal;

export const PRINCIPAL_IDENTIFIES: readonly PrincipalIdentifies[];
export const PRINCIPAL_AUTHENTICATION_METHODS: readonly string[];

/* -------------------------------- gate -------------------------------- */

export const EGRESS_REFUSAL_CODES: readonly string[];

/** The provider API version the shipped Anthropic transport speaks. */
export const ANTHROPIC_API_VERSION: string;

/**
 * What a transport's readiness probe observed. Deliberately not a verdict —
 * mapping a status to a customer-facing meaning is a product judgment (a
 * 429 is not an accepted credential even though reaching a rate limiter
 * usually means the request authenticated), and it is made by the caller.
 */
export type ProviderConnectionObservation =
  | {
      readonly reached: true;
      readonly status: number;
      /** Bounded snippet of the provider's own body on a non-2xx. */
      readonly bodySnippet: string | null;
      readonly probedUrl: string;
    }
  | {
      readonly reached: false;
      readonly kind: 'timeout' | 'network';
      readonly detail: string;
      readonly probedUrl: string;
    };

export interface EgressTransport {
  name: string;
  /**
   * Where this transport actually sends. OPTIONAL, and the optionality is
   * the control: a readiness probe cannot invent an endpoint for a
   * transport that does not describe one, so a relay or a test double
   * reports "cannot probe" rather than being probed at a guessed URL.
   * Never carries a credential.
   */
  readonly endpoint?: {
    readonly baseUrl: string;
    /**
     * PROVIDER-OPTIONAL, and optional here because it is genuinely absent
     * for some providers rather than merely unset. Anthropic's Messages API
     * is versioned by a dated `anthropic-version` header, so its transport
     * reports one; OpenAI's Chat Completions has no equivalent, so its
     * transport reports none. Declaring this required told TypeScript
     * consumers `endpoint.apiVersion` was a `string` on every transport
     * while it was `undefined` on one of the two that ship — and the
     * `.mjs` implementations are not checked against this declaration, so
     * nothing caught the disagreement. Inventing an OpenAI "apiVersion" to
     * satisfy the type would have fabricated a fact about the provider.
     */
    readonly apiVersion?: string;
  };
  /**
   * A credential readiness probe. OPTIONAL for the same reason `endpoint`
   * is: a caller cannot probe a transport that does not offer one, so a
   * relay or a capturing test double is reported unsupported rather than
   * probed at a guessed address with a guessed credential.
   *
   * It lives on the transport because the credential does. Implementing it
   * in a product or UI layer would be a second implementation of provider
   * authentication and would put a credential within reach of a layer whose
   * job is building response objects.
   *
   * Returns an OBSERVATION, never a verdict: `reached: true` means bytes
   * got to the provider and came back with a status — including a 401,
   * which is the probe's answer rather than an error — and the CALLER
   * decides what each status means. Never throws. Never carries a
   * credential.
   */
  testConnection?(): Promise<ProviderConnectionObservation>;
  send(payload: {
    documentText: string;
    prompt: string;
    purpose: string;
    destination: { provider: string; service: string };
  }): Promise<{ responseText?: string; providerMeta?: Record<string, unknown> } | void>;
}

export function releaseThroughGate(input: {
  store: AuthorizationStore;
  evidence: EvidenceLog;
  transport: EgressTransport;
  authorizationId: string | undefined;
  artifactText: string;
  prompt: string;
  destination: { provider: string; service: string };
  purpose: string;
  now?: () => number;
}): Promise<{
  released: boolean;
  decision: 'ALLOW' | 'DENY';
  reasonCode?: string;
  detail?: string;
  execution: 'completed' | 'failed' | 'unknown' | 'not_attempted';
  disclosureStatus: 'disclosed' | 'possibly_disclosed' | 'not_disclosed';
  authorizationId?: string;
  binding?: string;
  providerMeta?: Record<string, unknown> | null;
  responseText?: string | null;
  transportError?: { kind: string; message: string } | null;
  outcomeEvidenceRecorded?: boolean;
}>;

/* ------------------------------- pipeline ----------------------------- */

export interface GovernedArtifact {
  artifactId: string;
  originalHash: string;
  sanitizedHash?: string;
  mimeType: string;
  sizeBytes: number;
  filename?: string;
  classification: 'unknown' | 'clear' | 'phi_detected' | 'deidentified';
  transformation?: Omit<TransformationResult, 'text'>;
  verification: Partial<VerificationResult> & { status: string };
  /** One report per detection signal that ran. Absent when none is configured. */
  detectionSignals?: DetectionSignalReport[];
  /** Categories the policy marks `flag`: tokenized, and the release is marked for review. */
  flaggedCategories?: DetectionCategory[];
  /**
   * PDF extraction provenance. Present only for PDF sources. On a refusal it
   * carries `outcome: 'refused'` + the machine `reasonCode` + a content-free
   * `stage` (a member of `PDF_EXTRACTION_STAGES`, or null); on success it
   * carries `outcome: 'extracted'` + the hash of the extracted text. Never a
   * free-text message, filename, or path.
   */
  extraction?: PdfExtractionProvenance | null;
}

export type PdfExtractionProvenance =
  | {
      engine: 'mozilla-pdfjs';
      mode: 'local-in-process';
      outcome: 'refused';
      reasonCode: string;
      stage: PdfExtractionStage | null;
    }
  | {
      engine: 'mozilla-pdfjs';
      mode: 'local-in-process';
      outcome: 'extracted';
      extractedTextHash: string;
      originalArtifactHash: string;
    };

export interface GovernDeps {
  detector: SensitiveDataDetector;
  transformer: ArtifactTransformer;
  verifierDetector?: SensitiveDataDetector;
  /** Used when the policy sets `phi.replacement: 'synthetic'` (local mode only). */
  syntheticTransformer?: ArtifactTransformer;
  /** Stricter-only detection signals. None in production today. */
  signals?: DetectionSignal[];
  signalTimeoutMs?: number;
  store: AuthorizationStore;
  evidence: EvidenceLog;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Steps 1–5 of the pipeline and DELIBERATELY NOT 6: ingest, detect, the NFKC
 * reveal check, the prompt scan, transform, the mandatory rescan, and the
 * destination-policy decision. Mints no authorization and appends no
 * evidence, which is what makes it safe to call from a caller that will ask
 * the Strix kernel to authorize instead.
 *
 * Local mode (`governDocumentEgress`) and kernel mode both call this, so the
 * two modes differ in exactly one respect: who authorizes.
 */
/**
 * The refusal codes `pipeline.mjs` raises as literals, as a closed set.
 * Pinned against the call sites by `test/pipeline-deny-codes.test.mjs`, so a
 * consumer proving it has customer-facing language for every refusal can
 * enumerate them instead of maintaining a second list from memory.
 */
export const PIPELINE_DENY_CODES: readonly string[];

export function prepareDocumentForEgress(input: {
  source: ArtifactSource;
  prompt: string;
  destination: { provider: string; service: string };
  purpose: string;
  policy: EgressPolicy;
  /**
   * Recorded on a refusal receipt; NEVER read by the deciding half. The
   * decision is provably independent of who attempted it — pinned by a
   * source scan in `test/refusal-receipt.test.mjs`.
   */
  actor?: string | null;
  /**
   * What the boundary AUTHENTICATED, as opposed to what the caller declared.
   * Recorded on a refusal receipt; NEVER read by the deciding half, for a
   * sharper reason than `actor`: a verdict that could vary with the
   * credential would be a privileged bypass.
   */
  principal?: {
    authenticationMethod?: string;
    subject?: string | null;
    tenantId?: string | null;
  } | null;
  deps: {
    detector: SensitiveDataDetector;
    transformer: ArtifactTransformer;
    verifierDetector?: SensitiveDataDetector;
    /** Stricter-only detection signals. None in production today. */
    signals?: DetectionSignal[];
    signalTimeoutMs?: number;
    /**
     * Optional here, unlike `GovernDeps`. When present the refusal receipt is
     * APPENDED as an `egress_refused` entry; when absent it is still built and
     * returned. A failure to append never changes the refusal.
     */
    evidence?: EvidenceLog;
    /**
     * Governed OCR engine. Consulted ONLY when PDF.js refuses OCR_REQUIRED;
     * absent (the default) means an image-only PDF refuses exactly as before.
     */
    ocr?: GovernedOcrEngine | null;
    ocrThresholds?: OcrThresholds;
  };
}): Promise<
  | {
      outcome: 'DENY';
      reasonCode: string;
      detail: string;
      artifact: GovernedArtifact | null;
      /** Structured, persistable, value-free. Null only if it could not be built. */
      receipt: EgressRefusalReceipt | null;
    }
  | {
      outcome: 'PREPARED';
      /**
       * On the PREPARED branch the verification is COMPLETE, which the bare
       * `GovernedArtifact` type does not promise (mid-pipeline it is
       * legitimately `{status:'pending'}`). Both branches that can reach
       * PREPARED assign all three fields: the clear path records the scan it
       * already ran as the verification of record, and the sanitize path
       * assigns the mandatory rescan's own result. Narrowing here rather
       * than casting at the call site keeps the guarantee stated where it
       * holds — a cast would have hidden it, and `tsc` flagged exactly this
       * gap when the propose route handed the artifact to the commitment
       * builder, which requires all three.
       */
      artifact: Omit<GovernedArtifact, 'verification'> & {
        verification: { status: string; proves: string; remainingProhibitedFindings: number } & Partial<VerificationResult>;
      };
      releaseText: string;
      prompt: string;
      policy: EgressPolicy;
      destination: { provider: string; service: string };
      purpose: string;
      detection: DetectionResult;
      transformation: Omit<TransformationResult, 'text'> | null;
      sanitized: boolean;
      /**
       * Caller-held re-identification key (token → original value), or null
       * when nothing was tokenized. It carries raw values: never persist it,
       * log it, or put it in a response to anyone who did not supply the
       * document.
       */
      reidentification: ReidentificationKey | null;
    }
>;

export function governDocumentEgress(input: {
  source: ArtifactSource;
  prompt: string;
  destination: { provider: string; service: string };
  purpose: string;
  policy: EgressPolicy;
  actor?: string;
  deps: GovernDeps;
}): Promise<
  | {
      outcome: 'DENY';
      reasonCode: string;
      detail: string;
      artifact: GovernedArtifact | null;
      receipt: EgressRefusalReceipt | null;
    }
  | {
      outcome: 'ALLOW' | 'SANITIZE';
      artifact: GovernedArtifact;
      releaseText: string;
      prompt: string;
      authorization: EgressAuthorization;
      /** See the PREPARED branch above: caller-held, carries raw values. */
      reidentification: ReidentificationKey | null;
    }
>;

/* ------------------------------- adapter ------------------------------ */

export const EGRESS_CAPABILITY_ID: 'ai.external.document.send';
export const ANTHROPIC_DESTINATION: Readonly<{ provider: 'anthropic'; service: 'claude' }>;
export const DEFAULT_ANTHROPIC_MODEL: string;

export class TransportError extends Error {
  kind: 'unconfigured' | 'timeout' | 'network' | 'http';
}

export function createAnthropicMessagesTransport(options?: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): EgressTransport;

export function governedAnthropicDocumentRequest(input: {
  source: ArtifactSource;
  prompt: string;
  purpose?: string;
  actor?: string;
  policy: EgressPolicy;
  deps: GovernDeps;
  transport?: EgressTransport;
  /** Opt in to restoring original values in the answer for this caller. */
  reidentify?: boolean;
  /** Opt in to scanning the answer. `withhold` drops an answer with findings. */
  scanResponse?: boolean | { onFindings?: 'flag' | 'withhold' };
}): Promise<{
  released: boolean;
  decision: 'ALLOW' | 'SANITIZE' | 'DENY';
  reasonCode?: string | null;
  detail?: string;
  execution?: 'completed' | 'failed' | 'unknown' | 'not_attempted';
  disclosureStatus?: 'disclosed' | 'possibly_disclosed' | 'not_disclosed';
  artifact?: GovernedArtifact | null;
  receipt: EgressReceipt;
  /**
   * Present on DENY only: the record the pipeline MINTED AND APPENDED at the
   * refusal. Its `receiptId` is the correlation key into the evidence log,
   * which `receipt` above (built here, appended nowhere) does not carry.
   */
  refusalReceipt?: EgressRefusalReceipt | null;
  response?: string | null;
  providerMeta?: Record<string, unknown> | null;
  /** Only with `reidentify: true`. `response` stays the tokenized answer. */
  reidentifiedResponse?: string | null;
  reidentification?: ({ error: string | null } & Partial<ReidentificationReport>);
  /** Only with `scanResponse`. Categories and counts, never values. */
  responseScan?: { mode: 'flag' | 'withhold'; withheld: boolean; reason?: string } & Partial<ResponseScanReport> & {
    status: 'clean' | 'findings' | 'unavailable' | 'not_scanned';
  };
}>;

export const OPENAI_DESTINATION: Readonly<{ provider: 'openai'; service: 'chat-completions' }>;
export const DEFAULT_OPENAI_MODEL: string;

export class OpenAiTransportError extends Error {
  kind: 'unconfigured' | 'timeout' | 'network' | 'http';
}

export function createOpenAiChatTransport(options?: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): EgressTransport;

export function governedOpenAiDocumentRequest(input: {
  source: ArtifactSource;
  prompt: string;
  purpose?: string;
  actor?: string;
  policy: EgressPolicy;
  deps: GovernDeps;
  transport?: EgressTransport;
  /** Opt in to restoring original values in the answer for this caller. */
  reidentify?: boolean;
  /** Opt in to scanning the answer. `withhold` drops an answer with findings. */
  scanResponse?: boolean | { onFindings?: 'flag' | 'withhold' };
}): Promise<{
  released: boolean;
  decision: 'ALLOW' | 'SANITIZE' | 'DENY';
  reasonCode?: string | null;
  detail?: string;
  execution?: 'completed' | 'failed' | 'unknown' | 'not_attempted';
  disclosureStatus?: 'disclosed' | 'possibly_disclosed' | 'not_disclosed';
  artifact?: GovernedArtifact | null;
  receipt: EgressReceipt;
  /**
   * Present on DENY only: the record the pipeline MINTED AND APPENDED at the
   * refusal. Its `receiptId` is the correlation key into the evidence log,
   * which `receipt` above (built here, appended nowhere) does not carry.
   */
  refusalReceipt?: EgressRefusalReceipt | null;
  response?: string | null;
  providerMeta?: Record<string, unknown> | null;
  /** Only with `reidentify: true`. `response` stays the tokenized answer. */
  reidentifiedResponse?: string | null;
  reidentification?: ({ error: string | null } & Partial<ReidentificationReport>);
  /** Only with `scanResponse`. Categories and counts, never values. */
  responseScan?: { mode: 'flag' | 'withhold'; withheld: boolean; reason?: string } & Partial<ResponseScanReport> & {
    status: 'clean' | 'findings' | 'unavailable' | 'not_scanned';
  };
}>;

/* ------------------- Phase B: the canonical commitment ------------------ */

export const EGRESS_COMMITMENT_CANON: 'strix-egress-commitment-v1';
export const EGRESS_COMMITMENT_FIELDS: readonly string[];
export const AUTHORITY_SOURCED_FIELDS: readonly string[];
export const MATERIAL_DERIVED_FIELDS: readonly string[];

/**
 * The 17 committed fields. `canon` is field zero and is covered by the hash,
 * so a commitment written under another canon can never be compared against
 * one written under this canon — an unknown canon THROWS rather than being
 * re-interpreted under v1 rules.
 */
export interface EgressCommitmentFields {
  canon: 'strix-egress-commitment-v1';
  capability: string;
  tenantId: string;
  environment: string;
  actor: string;
  policyId: string;
  policyVersion: string;
  provider: string;
  service: string;
  purpose: string;
  /**
   * NOT re-derivable at the gate — the gate sees only the released bytes and
   * never the original document, so this comes from the redeemed decision's
   * frozen params. Typed and documented rather than quietly sourced.
   */
  initialClassification: string;
  releasedClassification: string;
  releasedArtifactHash: string;
  promptHash: string;
  verificationResult: string;
  verificationProves: string;
  remainingProhibitedFindings: number;
}

export interface EgressCommitment {
  canon: 'strix-egress-commitment-v1';
  canonicalBytes: string;
  commitmentHash: string;
}

export function canonicalizeEgressCommitment(fields: EgressCommitmentFields): string;
export function computeEgressCommitment(fields: EgressCommitmentFields): EgressCommitment;

/**
 * Exactly two sources, and no third parameter: a caller contributes nothing
 * to what the commitment says.
 */
export function assembleEgressCommitment(input: {
  authority: Record<string, unknown>;
  material: Record<string, unknown>;
}): EgressCommitment;

/* --------------------- Phase B: the kernel binding --------------------- */

export const AUTHORIZED_DECISION_STATES: readonly ['EXECUTING', 'EXECUTED'];
export const BINDING_REFUSAL_CODES: readonly string[];

export class BindingRefusal extends Error {
  reasonCode: string;
  detail: string;
}

/** DTO of a redeemed kernel decision. This package imports nothing from the console. */
export interface EgressDecisionDTO {
  id: string;
  state: string;
  actionType: string;
  tenantId: string;
  tokenRedeemed: boolean;
  actionParams: Record<string, unknown> | null;
}

export interface EgressAuthority {
  readonly decisionId: string;
  readonly canon: 'strix-egress-commitment-v1';
  readonly commitmentHash: string;
  readonly canonicalBytes: string;
  readonly capability: string;
  readonly tenantId: string;
  readonly environment: string;
  readonly actor: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly purpose: string;
  readonly initialClassification: string;
  readonly releasedClassification: string;
}

export function bindDecisionToEgressAuthority(input: {
  decision: EgressDecisionDTO | null;
  tenantId: string;
  consumeAuthority: () => boolean;
}): { authority: EgressAuthority; consumeAuthority: () => boolean };

export function egressCommitmentParamsFromPipeline(input: {
  tenantId: string;
  environment: string;
  actor: string;
  policyId: string;
  policyVersion: string;
  purpose: string;
  initialClassification: string;
  releasedClassification: string;
  destination: { provider: string; service: string };
  releasedText: string;
  prompt: string;
  verification: { status: string; proves: string; remainingProhibitedFindings: number };
}): {
  actionParams: Record<string, unknown>;
  commitmentHash: string;
  canonicalBytes: string;
};

export function receiptResultForSignedEvidence(gateResult: KernelEgressResult): {
  capability: string;
  canon: string;
  commitmentHash: string | null;
  execution: string | null;
  disclosureStatus: string | null;
  /** The anchor. Null is honest; a fabricated head would be worse than none. */
  evidenceChainHead: string | null;
  evidenceChainHeadRecorded: boolean;
  proves: 'CHAIN_HEAD_ANCHORED_TO_SIGNED_EVIDENCE';
};

/* -------------------- Phase B: the point-of-use gate ------------------- */

export const KERNEL_EGRESS_REFUSAL_CODES: readonly string[];

/**
 * A transport adapter that DECLARES its own destination. The gate reads
 * provider/service from here, never from a caller — a caller naming a
 * destination would be describing a route it does not control.
 */
export interface DestinationDeclaringAdapter extends EgressTransport {
  destination: { provider: string; service: string };
}

export interface KernelEgressResult {
  released: boolean;
  decision: 'ALLOW' | 'DENY';
  reasonCode?: string;
  detail?: string;
  execution: 'completed' | 'failed' | 'unknown' | 'not_attempted';
  disclosureStatus: 'disclosed' | 'possibly_disclosed' | 'not_disclosed';
  decisionId?: string;
  commitmentHash?: string;
  canon?: string;
  /** Present on COMMITMENT_MISMATCH: field NAMES only, never content. */
  divergentFields?: string[];
  authorizedCommitmentHash?: string;
  reconstructedCommitmentHash?: string;
  evidenceChainHead?: string | null;
  providerMeta?: Record<string, unknown> | null;
  responseText?: string | null;
  transportError?: { kind: string; message: string } | null;
  outcomeEvidenceRecorded?: boolean;
  now?: number;
}

/**
 * The choke point. Takes signed authority plus the ACTUAL outbound material
 * and reconstructs the commitment itself. There is deliberately no parameter
 * for a caller-supplied verification result, artifact hash, classification,
 * or destination — the absence is the control.
 */
export function releaseUnderKernelAuthority(input: {
  authority: EgressAuthority;
  material: { text: string; prompt: string };
  adapter: DestinationDeclaringAdapter;
  detector: SensitiveDataDetector;
  evidence: EvidenceLog;
  consumeAuthority: () => boolean;
  now?: () => number;
}): Promise<KernelEgressResult>;

/* --------------------------- re-identification ------------------------- */

/**
 * Caller-held: token → original value, bound to the hash of the released
 * text. Never stored by this package, never part of `artifact` or evidence.
 */
export interface ReidentificationKey {
  /** 1: tokens only. 2: synthetic replacement (entries carry `kind`). */
  keyVersion: 1 | 2;
  releaseHash: string;
  entries: readonly { token: string; category: string; value: string; kind?: 'token' | 'synthetic' }[];
}
export const REIDENTIFICATION_KEY_VERSION_SYNTHETIC: 2;
export function syntheticSurfaces(key: ReidentificationKey | null | undefined): string[];

export interface ReidentificationReport {
  releaseHash: string;
  restoredOccurrences: number;
  restoredTokens: number;
  unknownTokens: number;
  nearMissTokens: number;
  proves: 'EXACT_TOKENS_RESTORED_ONLY';
}

export const REIDENTIFICATION_KEY_VERSION: 1;
export const REIDENTIFICATION_PROVES: 'EXACT_TOKENS_RESTORED_ONLY';
export class ReidentificationError extends Error {
  reasonCode: 'KEY_MALFORMED' | 'KEY_RELEASE_MISMATCH' | 'RESPONSE_MALFORMED';
}
export function buildReidentificationKey(
  transformed: { restore?: { token: string; category: string; value: string }[] },
  releaseText: string,
): ReidentificationKey | null;
export function reidentifyResponse(input: {
  responseText: string;
  key: ReidentificationKey;
  releasedArtifactHash: string;
}): { text: string; report: ReidentificationReport };
export function reidentificationEvidenceEntry(
  report: ReidentificationReport,
  options?: { actor?: string | null },
): {
  type: 'egress_reidentified';
  actor: string | null;
  releasedArtifactHash: string;
  restoredOccurrences: number;
  restoredTokens: number;
  unknownTokens: number;
  nearMissTokens: number;
  proves: 'EXACT_TOKENS_RESTORED_ONLY';
};

export interface ResponseScanReport {
  status: 'clean' | 'findings';
  findingsCount: number;
  categories: readonly string[];
  responseHash: string;
  detector: Record<string, unknown> | null;
  proves: 'FINDINGS_BY_DETECTOR_ONLY';
}
export const RESPONSE_SCAN_PROVES: 'FINDINGS_BY_DETECTOR_ONLY';
export const RESPONSE_SCAN_MODES: readonly ['flag', 'withhold'];
export class ResponseScanError extends Error {
  reasonCode: 'SCAN_OPTION_MALFORMED' | 'RESPONSE_MALFORMED' | 'DETECTOR_UNAVAILABLE' | 'DETECTOR_MALFORMED';
}
export function responseScanMode(option: unknown): 'flag' | 'withhold' | null;
export function scanModelResponse(input: {
  responseText: string;
  detector: { scan(text: string): Promise<{ findingsCount: number; categories: string[]; detector?: unknown }> };
  /** Values this release generated (synthetic mode); blanked before the scan. */
  generatedValues?: string[];
}): Promise<ResponseScanReport>;
export function responseScanEvidenceEntry(
  report: Partial<ResponseScanReport> & { status: string },
  options?: { actor?: string | null; mode: 'flag' | 'withhold'; withheld: boolean; releasedArtifactHash?: string | null },
): Record<string, unknown> & { type: 'egress_response_scanned' };

export const CATEGORY_ACTIONS: readonly ['tokenize', 'flag', 'block'];
export function categoryAction(policy: EgressPolicy, category: string): 'tokenize' | 'flag' | 'block';

export const REPLACEMENT_MODES: readonly ['token', 'synthetic'];
export function replacementMode(policy: EgressPolicy): 'token' | 'synthetic';
export const SYNTHETIC_ENGINE: Readonly<{ name: 'strix-synthetic-replacer'; version: string }>;
export const SYNTHETIC_CATEGORIES: readonly ['PATIENT_NAME', 'PHONE', 'EMAIL'];
export function syntheticValueFor(category: string, n: number, sourceLower?: string): string | null;
export function createSyntheticTransformer(): ArtifactTransformer;

/* ------------------------------- proxy -------------------------------- */

export const PROXY_INFO: Readonly<{ name: 'strix-egress-proxy'; version: string }>;
export const MAX_PROXY_BODY_BYTES: number;
export const MIN_TOKEN_LENGTH: 32;
export class ProxyRequestError extends Error {
  status: number;
  code: string;
}
export function parseChatRequest(
  body: unknown,
  shape: 'openai' | 'anthropic',
): { document: string; prompt: string; model: string | null; ignored: string[] };
export function createEgressProxy(config: {
  policy: EgressPolicy;
  provider: 'anthropic' | 'openai';
  token: string;
  model?: string;
  allowedModels?: string[];
  actor?: string;
  /** The operator's own provider endpoint; absolute https only. */
  baseUrl?: string;
  reidentify?: boolean;
  scanResponse?: boolean | { onFindings?: 'flag' | 'withhold' };
  transportFor?: (model: string) => EgressTransport;
  deps?: Partial<GovernDeps>;
  /** Ed25519-sign every evidence record with a customer-held key. */
  evidenceSigner?: Pick<EvidenceSigner, 'keyId' | 'sign'>;
  /** Continue an existing log's chain (from `resumePointOf`). */
  evidenceResume?: { seq: number; headHash: string };
  onEvidence?: (record: Record<string, unknown>) => void;
  log?: (line: string) => void;
}): {
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void>;
  evidence: EvidenceLog;
  listen(options?: { port?: number; host?: string; tls?: { cert: Buffer | string; key: Buffer | string } | null }): Promise<import('node:http').Server>;
};
