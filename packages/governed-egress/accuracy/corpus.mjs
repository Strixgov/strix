// The per-entity accuracy corpus: every one of the twelve detection
// categories, in labelled and unlabelled forms, with decoys that look like
// identifiers and are not.
//
// Doc shape: { id, text, truth: [{ span, category, nth? }], decoys: [span] }.
// `nth` selects which occurrence of the span (0-based) when a string repeats.
//
// READ THIS BEFORE QUOTING A NUMBER. The corpus is invented, and it was
// written by the same author as the detector, with knowledge of its rules.
// Some forms here were chosen BECAUSE they are realistic and the author
// expected the detector to miss them (unlabelled values, dotted phones,
// spelled-out dates, PO boxes); the report shows those misses rather than
// dropping the forms. It is a regression instrument and an honest map of
// known gaps, not an independent benchmark. Real test values are avoided:
// SSNs use SSA's advertising range (987-65-4320…4329), cards are the
// networks' published test numbers, phones are 555-01xx, emails use
// .example domains.

// 0.2.0 (2026-10-06): one label changed, no text changed. "The practice
// files under TIN 98-7654321" moved from truth to decoys: operator decision
// Q1 keeps a provider's EIN-shaped TIN by default (detector 0.8.0). The
// unlabelled-by-provider "EIN: 12-3456789" stays truth.
export const CORPUS_VERSION = '0.2.0';

export const DOCS = [
  // ── PATIENT_NAME ────────────────────────────────────────────────────────
  {
    id: 'name-labelled',
    text: 'Patient: Marisol Achterberg\nVisit type: follow-up\nMarisol Achterberg reports improved sleep.',
    truth: [
      { span: 'Marisol Achterberg', category: 'PATIENT_NAME', nth: 0 },
      { span: 'Marisol Achterberg', category: 'PATIENT_NAME', nth: 1 },
    ],
    decoys: ['follow-up'],
  },
  {
    id: 'name-labelled-surname-later',
    text: 'Patient Name: Desmond Oyelaran-Hughes\nMr. Oyelaran-Hughes was counselled on diet.',
    truth: [
      { span: 'Desmond Oyelaran-Hughes', category: 'PATIENT_NAME' },
      { span: 'Oyelaran-Hughes', category: 'PATIENT_NAME', nth: 1 },
    ],
    decoys: [],
  },
  {
    id: 'name-unlabelled',
    text: 'Spoke with Evangeline Thorsby about the outstanding balance; she will call back Friday.',
    truth: [{ span: 'Evangeline Thorsby', category: 'PATIENT_NAME' }],
    decoys: ['Friday'],
  },
  {
    id: 'name-decoys-only',
    text: 'The Lincoln Medical Center billing team met Tuesday to review the Grace period policy for Mercy Hospital.',
    truth: [],
    decoys: ['Lincoln Medical Center', 'Grace', 'Mercy Hospital', 'Tuesday'],
  },

  // ── DATE ────────────────────────────────────────────────────────────────
  {
    id: 'date-labelled',
    text: 'DOB: 04/17/1962\nDate of service: 2025-11-03\nAdmission date: 12/01/2025',
    truth: [
      { span: '04/17/1962', category: 'DATE' },
      { span: '2025-11-03', category: 'DATE' },
      { span: '12/01/2025', category: 'DATE' },
    ],
    decoys: [],
  },
  {
    id: 'date-unlabelled-forms',
    text: 'She was first seen on March 3, 2024 and again on 3/14/24 before the 2024-06-30 review.',
    truth: [
      { span: 'March 3, 2024', category: 'DATE' },
      { span: '3/14/24', category: 'DATE' },
      { span: '2024-06-30', category: 'DATE' },
    ],
    decoys: [],
  },
  {
    id: 'date-decoys',
    text: 'Use form 1/2 for part A. Dosage 10/20 mg. Fiscal year 2025 closed; ratio 3/4 met.',
    truth: [],
    decoys: ['1/2', '10/20', '2025', '3/4'],
  },

  // ── MRN ─────────────────────────────────────────────────────────────────
  {
    id: 'mrn-labelled',
    text: 'MRN: 00418872\nMedical record number: A-7719032',
    truth: [
      { span: '00418872', category: 'MRN' },
      { span: 'A-7719032', category: 'MRN' },
    ],
    decoys: [],
  },
  {
    id: 'mrn-unlabelled',
    text: 'Chart 00418872 was merged with the duplicate record last week.',
    truth: [{ span: '00418872', category: 'MRN' }],
    decoys: [],
  },

  // ── SSN ─────────────────────────────────────────────────────────────────
  {
    id: 'ssn-forms',
    text: 'SSN: 987-65-4320\nSocial security number: 987654321\nOn the form she wrote 987-65-4322.',
    truth: [
      { span: '987-65-4320', category: 'SSN' },
      { span: '987654321', category: 'SSN' },
      { span: '987-65-4322', category: 'SSN' },
    ],
    decoys: [],
  },
  {
    id: 'ssn-unlabelled-nodash',
    text: 'The caller read out 987654323 as her social before the line dropped.',
    truth: [{ span: '987654323', category: 'SSN' }],
    decoys: [],
  },

  // ── PHONE ───────────────────────────────────────────────────────────────
  {
    id: 'phone-forms',
    text: 'Phone: (615) 555-0142\nCell 615-555-0177, work +1 615 555 0188, fax 615.555.0199.',
    truth: [
      { span: '(615) 555-0142', category: 'PHONE' },
      { span: '615-555-0177', category: 'PHONE' },
      { span: '+1 615 555 0188', category: 'PHONE' },
      { span: '615.555.0199', category: 'PHONE' },
    ],
    decoys: [],
  },
  {
    id: 'phone-decoys',
    text: 'CPT 99214 billed twice; claim 20250113 resubmitted; ZIP 37066 on file; NPI 1234567893.',
    truth: [],
    decoys: ['99214', '20250113', '37066', '1234567893'],
  },

  // ── EMAIL ───────────────────────────────────────────────────────────────
  {
    id: 'email-forms',
    text: 'Email: m.achterberg@example.com\nCopy dthorsby+billing@mail.example.org on the reply.',
    truth: [
      { span: 'm.achterberg@example.com', category: 'EMAIL' },
      { span: 'dthorsby+billing@mail.example.org', category: 'EMAIL' },
    ],
    decoys: [],
  },

  // ── ADDRESS ─────────────────────────────────────────────────────────────
  {
    id: 'address-forms',
    text: 'Address: 4180 Harrow Mill Road, Gallatin, TN 37066\nMail statements to PO Box 2291, Hendersonville, TN 37075.',
    truth: [
      { span: '4180 Harrow Mill Road', category: 'ADDRESS' },
      { span: 'Gallatin, TN 37066', category: 'ADDRESS' },
      { span: 'PO Box 2291', category: 'ADDRESS' },
      { span: 'Hendersonville, TN 37075', category: 'ADDRESS' },
    ],
    decoys: [],
  },
  {
    id: 'address-unit',
    text: 'She moved to 77 Quarry Lane Apt 4B last spring.',
    truth: [{ span: '77 Quarry Lane', category: 'ADDRESS' }],
    decoys: [],
  },

  // ── INSURANCE_ID ────────────────────────────────────────────────────────
  {
    id: 'insurance-labelled',
    text: 'Member ID: XJH448120937\nGroup number: 0081734\nSubscriber ID: W2294017735',
    truth: [
      { span: 'XJH448120937', category: 'INSURANCE_ID' },
      { span: '0081734', category: 'INSURANCE_ID' },
      { span: 'W2294017735', category: 'INSURANCE_ID' },
    ],
    decoys: [],
  },
  {
    id: 'insurance-unlabelled',
    text: 'Payer rejected XJH448120937 as inactive for the date of service.',
    truth: [{ span: 'XJH448120937', category: 'INSURANCE_ID' }],
    decoys: [],
  },

  // ── OTHER_ID ────────────────────────────────────────────────────────────
  {
    id: 'other-id-labelled',
    text: 'Accession number: LX-20251103-0457\nSpecimen ID: SPC99812004\nAccount number: 70031948',
    truth: [
      { span: 'LX-20251103-0457', category: 'OTHER_ID' },
      { span: 'SPC99812004', category: 'OTHER_ID' },
      { span: '70031948', category: 'OTHER_ID' },
    ],
    decoys: [],
  },

  // ── PAYMENT_CARD ────────────────────────────────────────────────────────
  {
    id: 'card-forms',
    text: 'Paid with 4111 1111 1111 1111 last month and 5555-5555-5555-4444 today; Amex 378282246310005 on file.',
    truth: [
      { span: '4111 1111 1111 1111', category: 'PAYMENT_CARD' },
      { span: '5555-5555-5555-4444', category: 'PAYMENT_CARD' },
      { span: '378282246310005', category: 'PAYMENT_CARD' },
    ],
    decoys: [],
  },
  {
    id: 'card-decoys',
    text: 'Tracking 1234 5678 9012 3456 shipped; batch 4111111111111112 rejected by the lab system.',
    truth: [],
    decoys: ['1234 5678 9012 3456', '4111111111111112'],
  },

  // ── FINANCIAL_ACCOUNT ───────────────────────────────────────────────────
  {
    id: 'account-forms',
    text: 'Refund to IBAN GB82 WEST 1234 5698 7654 32.\nBank account: 000123456789, routing 021000021.',
    truth: [
      { span: 'GB82 WEST 1234 5698 7654 32', category: 'FINANCIAL_ACCOUNT' },
      { span: '000123456789', category: 'FINANCIAL_ACCOUNT' },
    ],
    decoys: [],
  },

  // ── TAX_ID ──────────────────────────────────────────────────────────────
  {
    id: 'tax-id-forms',
    text: 'EIN: 12-3456789\nThe practice files under TIN 98-7654321.',
    truth: [
      { span: '12-3456789', category: 'TAX_ID' },
    ],
    decoys: ['98-7654321'],
  },

  // ── clean text: nothing to find ─────────────────────────────────────────
  {
    id: 'clean-clinical',
    text: 'Comprehensive metabolic panel within reference ranges. Continue current regimen and recheck lipids in six months.',
    truth: [],
    decoys: ['six months'],
  },
];
