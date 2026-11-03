// Lab revenue-cycle detection packs — HELD-OUT corpus, Phase 0.
// Committed with the development corpus and BEFORE any pack rule exists; its
// sha256 is recorded in HASHES.md. Rules must never be tuned against it.
// Different wording and layouts from corpus-dev.mjs. Same invented-value
// conventions. Same author, so not an independent benchmark.

export const LAB_HELDOUT_VERSION = '0.1.0';

export const LAB_HELDOUT = [
  {
    id: 'ho-req-handwritten-style',
    family: 'lab-requisition',
    text: 'pt name: Ferreira-Lund, Odalys  dob 1971-04-08  acc# LX40418873  spec 4418-772-03  drawn 10/01/26 0915  orders: 83036 (A1c), 82947  dx R73.03',
    truth: [
      { span: 'Ferreira-Lund, Odalys', category: 'PATIENT_NAME' },
      { span: '1971-04-08', category: 'DATE' },
      { span: 'LX40418873', category: 'OTHER_ID' },
      { span: '4418-772-03', category: 'OTHER_ID' },
      { span: '10/01/26', category: 'DATE' },
    ],
    decoys: ['83036', '82947', 'R73.03'],
    policyDependent: [],
  },
  {
    id: 'ho-eob-table',
    family: 'eob-835',
    text: 'Insured | ID | Acct | ICN | DOS | Code | Allowed\nBeaumont Kiplagat | QPR90017744 | 33-0091 | 20263040099101 | 08/08/2026 | 86803 | $21.04\nGroup CO-16, remark MA130',
    truth: [
      { span: 'Beaumont Kiplagat', category: 'PATIENT_NAME' },
      { span: 'QPR90017744', category: 'INSURANCE_ID' },
      { span: '33-0091', category: 'OTHER_ID' },
      { span: '20263040099101', category: 'OTHER_ID' },
      { span: '08/08/2026', category: 'DATE' },
    ],
    decoys: ['86803', '$21.04', 'MA130'],
    policyDependent: [],
  },
  {
    id: 'ho-denial-salutation',
    family: 'denial-appeal',
    text: 'Our ref: MPS/7731905/LAB\nHello Mr. Ezekiel Nakashima-Brandt — we reviewed services billed 3/30/2026 (87798, 87481). Per clinical policy LAB-2026-207 these are not covered. Denial code 96.',
    truth: [
      { span: 'MPS/7731905/LAB', category: 'OTHER_ID' },
      { span: 'Ezekiel Nakashima-Brandt', category: 'PATIENT_NAME' },
      { span: '3/30/2026', category: 'DATE' },
    ],
    decoys: ['87798', '87481', 'LAB-2026-207'],
    policyDependent: [],
  },
  {
    id: 'ho-provider-mixed',
    family: 'provider-ids',
    text: 'Ordered by Dr. Ines Halvorsen (NPI 1999908830) for patient Wren Abernathy-Sol; performed at Lakeside Molecular, CLIA 99D9977120.',
    truth: [{ span: 'Wren Abernathy-Sol', category: 'PATIENT_NAME' }],
    decoys: ['Lakeside Molecular', '99D9977120'],
    policyDependent: ['Ines Halvorsen', '1999908830'],
  },
];
