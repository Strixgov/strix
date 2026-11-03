// Lab revenue-cycle detection packs — HELD-OUT corpus, Phase 2.
// Committed with corpus-dev-p2.mjs and BEFORE any Phase 2 rule or the
// date-time fix exists; its sha256 is recorded in HASHES.md. Rules must never
// be tuned against it. Different wording and layouts from the dev split.
// Same conventions and `providerIds` key as corpus-dev-p2.mjs.
// Same author, so not an independent benchmark.

export const LAB_HELDOUT_P2_VERSION = '0.1.0';

export const LAB_HELDOUT_P2 = [
  {
    id: 'ho2-denial-letterhead',
    family: 'denial-appeal',
    text: 'NorthStar Health Plan · Utilization Review\nFile #: UR-88140027\nAttn: Cordelia Ashby-Nwosu\nDear Mrs. Ashby-Nwosu — coverage for 81225 and 81226 on 07/30/2026 was denied under laboratory policy NS-LAB-412. Remark codes M127, N290.',
    truth: [
      { span: 'UR-88140027', category: 'OTHER_ID' },
      { span: 'Cordelia Ashby-Nwosu', category: 'PATIENT_NAME' },
      { span: 'Ashby-Nwosu', category: 'PATIENT_NAME' },
      { span: '07/30/2026', category: 'DATE' },
    ],
    decoys: ['NorthStar Health Plan', '81225', '81226', 'NS-LAB-412', 'M127', 'N290'],
    providerIds: [],
  },
  {
    id: 'ho2-appeal-short',
    family: 'denial-appeal',
    text: 'Appeal for Florian Abiodun-Reyes, claim 20263110087251, DOS 9/02/26 collected 13:40 — requesting review of CARC 50 under policy LAB-2025-188 (CPT 87507).',
    truth: [
      { span: 'Florian Abiodun-Reyes', category: 'PATIENT_NAME' },
      { span: '20263110087251', category: 'OTHER_ID' },
      { span: '9/02/26', category: 'DATE' },
      { span: '13:40', category: 'DATE' },
    ],
    decoys: ['LAB-2025-188', '87507'],
    providerIds: [],
  },
  {
    id: 'ho2-specimen-stamp',
    family: 'date-time',
    text: 'SPECIMEN RECEIVED 2026-09-21 08:15:30 · Tracking SR-4471-0098 · Ana-Lucia Brennan-Otieno · panel 80076 · stability 72 hours at 2-8 C',
    truth: [
      { span: '2026-09-21', category: 'DATE' },
      { span: '08:15:30', category: 'DATE' },
      { span: 'SR-4471-0098', category: 'OTHER_ID' },
      { span: 'Ana-Lucia Brennan-Otieno', category: 'PATIENT_NAME' },
    ],
    decoys: ['80076', '72 hours', '2-8 C'],
    providerIds: [],
  },
  {
    id: 'ho2-provider-referral',
    family: 'provider-ids',
    text: 'Referring physician Dr. Nnamdi Castellano (NPI 1999909914, group TIN 99-2468013) — patient Odile Marchetti-Waweru, DOB 11/23/1949.',
    truth: [
      { span: 'Odile Marchetti-Waweru', category: 'PATIENT_NAME' },
      { span: '11/23/1949', category: 'DATE' },
    ],
    decoys: [],
    providerIds: ['Nnamdi Castellano', '1999909914', '99-2468013'],
  },
  {
    id: 'ho2-sole-tin',
    family: 'provider-ids',
    text: 'Provider: Esperanza Lindahl, PhD (TIN 987-65-4322, NPI 1999901127) — Patient: Jasper Oyelaran',
    truth: [
      { span: '987-65-4322', category: 'SSN' },
      { span: 'Jasper Oyelaran', category: 'PATIENT_NAME' },
    ],
    decoys: [],
    providerIds: ['Esperanza Lindahl', '1999901127'],
  },
  {
    id: 'ho2-decoy-times',
    family: 'date-time',
    text: 'Courier pickup 16:30 daily; batch 2026-B; run time 45 min; QC lot 4471; hours 08:00-17:00 Mon-Fri',
    truth: [],
    decoys: ['16:30', '2026-B', '45 min', '4471', '08:00-17:00'],
    providerIds: [],
  },
];
