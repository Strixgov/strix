// Held-out accuracy corpus (0.1.0), written and committed BEFORE detector
// 0.6.0's rules existed, so the rules could not have been fitted to it. Git
// history is the proof: this file lands in its own commit ahead of the
// detector change, and the report generated at that commit shows how the
// 0.5.0 detector did on it.
//
// It covers the same forms the main corpus showed surviving under 0.5.0
// (unlabelled names, ISO and two-digit-year dates, PO boxes, unlabelled
// SSNs, MRNs and member IDs) but in different wording, plus decoys chosen to
// catch rules that would be too loose for those forms.
//
// Be exact about what "held out" means here. The author knew which FORMS the
// 0.6.0 rules would target when writing this; the rules' exact patterns and
// marker words did not exist yet. That protects against fitting a pattern to
// these sentences, not against an author who writes cases their own approach
// will handle. It is still not an independent benchmark.
//
// Same doc shape and value conventions as corpus.mjs.

export const HELD_OUT_VERSION = '0.1.0';

export const HELD_OUT = [
  // ── names with no label and an unlisted given name ─────────────────────
  {
    id: 'ho-name-voicemail',
    text: 'Left a voicemail for Thaddeus Quirke regarding the refund timeline.',
    truth: [{ span: 'Thaddeus Quirke', category: 'PATIENT_NAME' }],
    decoys: [],
  },
  {
    id: 'ho-name-met-with',
    text: 'Met with Oluwaseun Adeyemi-Park and her daughter to go over the estimate.',
    truth: [{ span: 'Oluwaseun Adeyemi-Park', category: 'PATIENT_NAME' }],
    decoys: [],
  },
  {
    id: 'ho-name-decoys',
    text: 'Called Mercy Hospital to confirm the fax, then spoke with Billing Team about the appeal window.',
    truth: [],
    decoys: ['Mercy Hospital', 'Billing Team'],
  },

  // ── dates ──────────────────────────────────────────────────────────────
  {
    id: 'ho-dates',
    text: 'Seen 2023-02-28 and again 7/4/23; the next visit is booked for 2026-01-15.',
    truth: [
      { span: '2023-02-28', category: 'DATE' },
      { span: '7/4/23', category: 'DATE' },
      { span: '2026-01-15', category: 'DATE' },
    ],
    decoys: [],
  },
  {
    id: 'ho-date-decoys',
    text: 'Build 2024-13-45 failed the lint step. She scored 12/31 on the intake quiz and 4/5 on recall.',
    truth: [],
    decoys: ['2024-13-45', '12/31', '4/5'],
  },

  // ── addresses ──────────────────────────────────────────────────────────
  {
    id: 'ho-pobox',
    text: 'Remit payment to P.O. Box 88120, Nashville, TN 37202 by the due date.',
    truth: [
      { span: 'P.O. Box 88120', category: 'ADDRESS' },
      { span: 'Nashville, TN 37202', category: 'ADDRESS' },
    ],
    decoys: [],
  },
  {
    id: 'ho-box-decoy',
    text: 'Check box 12 on the form and leave the comment box empty.',
    truth: [],
    decoys: ['box 12'],
  },

  // ── SSN without a dash or label ────────────────────────────────────────
  {
    id: 'ho-ssn-intake',
    text: 'At intake the member gave social 987654325 and asked us not to mail it.',
    truth: [{ span: '987654325', category: 'SSN' }],
    decoys: [],
  },
  {
    id: 'ho-nine-digit-decoy',
    text: 'Ticket 987654321 was closed after the portal reset.',
    truth: [],
    decoys: ['987654321'],
  },

  // ── MRN without its label ──────────────────────────────────────────────
  {
    id: 'ho-mrn-chart',
    text: 'Pulled chart #A2291034 for the audit sample.',
    truth: [{ span: 'A2291034', category: 'MRN' }],
    decoys: [],
  },
  {
    id: 'ho-chart-decoy',
    text: 'Chart review is pending for the Q3 audit; see chart notes.',
    truth: [],
    decoys: ['review', 'notes'],
  },

  // ── member ID without its label ────────────────────────────────────────
  {
    id: 'ho-member-id',
    text: 'Coverage for member XQP77120045 terminated in May.',
    truth: [{ span: 'XQP77120045', category: 'INSURANCE_ID' }],
    decoys: [],
  },
  {
    id: 'ho-code-decoy',
    text: 'The payer applied CPT99214 and modifier 25 to the claim.',
    truth: [],
    decoys: ['CPT99214'],
  },
];
