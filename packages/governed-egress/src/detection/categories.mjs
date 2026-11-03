/**
 * The closed detection-category vocabulary for governed egress v0.1, and the
 * TOTAL category→token-prefix map the transformer uses.
 *
 * TOKEN_PREFIX is deliberately total over DETECTION_CATEGORIES and the
 * transformer REFUSES an unmapped category rather than defaulting to a
 * nearest match or a generic bucket — the assurance-vocabulary rule
 * (docs/architecture/assurance-vocabulary-mapping-v1.md): a semantic
 * fallback here would tokenize a finding under a label naming the wrong
 * thing, which is a confident wrong statement in the released artifact.
 */
export const DETECTION_CATEGORIES = Object.freeze([
  'PATIENT_NAME',
  'DATE',
  'MRN',
  'SSN',
  'PHONE',
  'EMAIL',
  'ADDRESS',
  'INSURANCE_ID',
  'OTHER_ID',
  // 0.3.0 — financial and tax identifiers.
  'PAYMENT_CARD',
  'FINANCIAL_ACCOUNT',
  'TAX_ID',
  // 0.7.0 — provider identifiers (NPI, a provider's name), produced only by
  // the opt-in provider-ids pack. Their own category so a provider is never
  // tokenized under a label that says "patient".
  'PROVIDER_ID',
]);

export const TOKEN_PREFIX = Object.freeze({
  PATIENT_NAME: 'PATIENT',
  DATE: 'DATE',
  MRN: 'MRN',
  SSN: 'SSN',
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  ADDRESS: 'ADDRESS',
  INSURANCE_ID: 'INSURANCE',
  OTHER_ID: 'ID',
  PAYMENT_CARD: 'CARD',
  FINANCIAL_ACCOUNT: 'ACCOUNT',
  TAX_ID: 'TAXID',
  PROVIDER_ID: 'PROVIDER',
});
