// Lab revenue-cycle detection packs — DEVELOPMENT corpus, Phase 2.
// Plan: docs/strategy/specs/lab-rcm-detection-packs-plan-v1.md.
//
// Families: denial-appeal, provider-ids, and date-with-time (Q2). Written and
// committed BEFORE any Phase 2 rule or the date-time fix exists. Same
// invented-value conventions as corpus-dev.mjs (SSNs 987-65-432x, made-up
// NPI/CLIA/TIN shapes). Real public CPT/ICD-10/CARC/RARC codes in decoys.
//
// New key `providerIds`: provider identifiers (Q1, answered 2026-10-06: keep
// by default, replace when the deployment turns on the `provider-ids` pack).
// Scored separately from truth and decoys: kept without the pack, replaced
// with it. A TIN in SSN format is NOT a provider id here; it is truth (SSN).
//
// Same author as the detector; a regression instrument, not an independent benchmark.

export const LAB_DEV_P2_VERSION = '0.1.0';

export const LAB_DEV_P2 = [
  {
    id: 'dp2-denial-header',
    family: 'denial-appeal',
    text: [
      'Meridian Payer Services — Appeals Unit',
      'Case number: APL-2026-0091846',
      'Re: Wilhelmina Castellanos-Pyke',
      'Dear Ms. Castellanos-Pyke,',
      'We upheld the denial of CPT 81528 billed for 04/27/2026 under medical policy LAB-2024-077 (CARC 50, RARC N115).',
    ].join('\n'),
    truth: [
      { span: 'APL-2026-0091846', category: 'OTHER_ID' },
      { span: 'Wilhelmina Castellanos-Pyke', category: 'PATIENT_NAME' },
      { span: 'Castellanos-Pyke', category: 'PATIENT_NAME' },
      { span: '04/27/2026', category: 'DATE' },
    ],
    decoys: ['Meridian Payer Services', 'Appeals Unit', '81528', 'LAB-2024-077', 'N115'],
    providerIds: [],
  },
  {
    id: 'dp2-appeal-prose',
    family: 'denial-appeal',
    text: 'We request reconsideration of claim number 20262770031904 for our patient, Thaddeus Okafor-Lindgren (member ID HZP44017729), whose specimen was collected on 08/02/2026 at 11:20. The ordering physician documented ICD-10 Z85.3; CPT 81162 meets policy MP-LAB-0331.',
    truth: [
      { span: '20262770031904', category: 'OTHER_ID' },
      { span: 'Thaddeus Okafor-Lindgren', category: 'PATIENT_NAME' },
      { span: 'HZP44017729', category: 'INSURANCE_ID' },
      { span: '08/02/2026', category: 'DATE' },
      { span: '11:20', category: 'DATE' },
    ],
    decoys: ['Z85.3', '81162', 'MP-LAB-0331'],
    providerIds: [],
  },
  {
    id: 'dp2-denial-our-ref',
    family: 'denial-appeal',
    text: 'Our reference: QX/5520193/APPEAL\nDear Ruairi Mbeki-Sorensen:\nThe service on 2026-05-14 (87631) is denied; see coverage policy LAB-2026-009. Denial reason code 197.',
    truth: [
      { span: 'QX/5520193/APPEAL', category: 'OTHER_ID' },
      { span: 'Ruairi Mbeki-Sorensen', category: 'PATIENT_NAME' },
      { span: '2026-05-14', category: 'DATE' },
    ],
    decoys: ['87631', 'LAB-2026-009', '197'],
    providerIds: [],
  },
  {
    id: 'dp2-patient-signed',
    family: 'denial-appeal',
    text: 'Please reconsider the denial for CPT 80305.\nThank you,\nHollis Varga-Eze (patient)\nAppeal ID 77120-0045-3',
    truth: [
      { span: 'Hollis Varga-Eze', category: 'PATIENT_NAME' },
      { span: '77120-0045-3', category: 'OTHER_ID' },
    ],
    decoys: ['80305'],
    providerIds: [],
  },
  {
    id: 'dp2-collection-times',
    family: 'date-time',
    text: 'Collected: 09/14/2026 07:42   Received: 09/14/2026 at 9:05 AM\nCollection time: 0630\nLab hours 07:00-18:00; turnaround 24 hours; reference range 3.5-5.0 mmol/L',
    truth: [
      { span: '09/14/2026', category: 'DATE' },
      { span: '07:42', category: 'DATE' },
      { span: '9:05 AM', category: 'DATE' },
      { span: '0630', category: 'DATE' },
    ],
    decoys: ['07:00-18:00', '24 hours', '3.5-5.0'],
    providerIds: [],
  },
  {
    id: 'dp2-iso-datetime',
    family: 'date-time',
    text: 'drawn 2026-08-30T14:05 | spec# SX-55102 | pt Kowalczyk, Imogen | 85610 PT/INR',
    truth: [
      { span: '2026-08-30', category: 'DATE' },
      { span: '14:05', category: 'DATE' },
      { span: 'SX-55102', category: 'OTHER_ID' },
      { span: 'Kowalczyk, Imogen', category: 'PATIENT_NAME' },
    ],
    decoys: ['85610'],
    providerIds: [],
  },
  {
    id: 'dp2-provider-block',
    family: 'provider-ids',
    text: 'Rendering provider: Dr. Saoirse Adebayo-Klein, NPI 1999906612\nBilling provider: Cascade Clinical Labs, TIN 99-7654321, NPI 1999903345\nPatient: Leopold Tran-Whitaker   DOB 03/09/1966',
    truth: [
      { span: 'Leopold Tran-Whitaker', category: 'PATIENT_NAME' },
      { span: '03/09/1966', category: 'DATE' },
    ],
    decoys: ['Cascade Clinical Labs'],
    providerIds: ['Saoirse Adebayo-Klein', '1999906612', '99-7654321', '1999903345'],
  },
  {
    id: 'dp2-sole-practitioner-tin',
    family: 'provider-ids',
    text: 'Rendering: Marisol Quintero-Hale, LCSW, TIN 987-65-4327 (individual), NPI 1999905518. Patient: Bartholomew Ikeda.',
    truth: [
      { span: '987-65-4327', category: 'SSN' },
      { span: 'Bartholomew Ikeda', category: 'PATIENT_NAME' },
    ],
    decoys: [],
    providerIds: ['Marisol Quintero-Hale', '1999905518'],
  },
];
