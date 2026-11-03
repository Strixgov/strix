// Lab revenue-cycle detection packs — DEVELOPMENT corpus, Phase 0.
// Plan: docs/strategy/specs/lab-rcm-detection-packs-plan-v1.md.
//
// Written and committed BEFORE any pack rule exists. All values are invented:
// SSNs use the 987-65-432x advertising range, phones 555-01xx, emails
// .example, NPIs and CLIA numbers are made-up shapes (not checked against any
// registry). CPT, ICD-10, CARC and RARC codes are real public code values,
// because preserving them is the point of the decoy lists.
//
// Doc shape: { id, family, text, truth: [{ span, category, nth? }],
//              decoys: [span],          // must be PRESERVED (utility)
//              policyDependent: [span] } // e.g. NPI: tokenize or keep per Q1,
//                                        // excluded from both scores
// Same author as the detector; a regression instrument, not an independent benchmark.

export const LAB_DEV_VERSION = '0.1.0';

export const LAB_DEV = [
  // ── lab-requisition ─────────────────────────────────────────────────────
  {
    id: 'req-standard',
    family: 'lab-requisition',
    text: [
      'TEST REQUISITION',
      'Patient: Delphine Okonkwo-Reyes   DOB: 02/11/1958   MRN: 40092217',
      'Accession #: AC-2026-0447812   Specimen ID: SP99031877',
      'Collected: 09/14/2026 07:42',
      'Ordering provider: Dr. Tomasz Wierzbicki   NPI: 1999904413',
      'Tests: 80053 Comprehensive metabolic panel; 85025 CBC with differential',
      'Dx: E11.9, I10   Specimen type: serum, whole blood',
      'Performing lab CLIA: 99D9912345',
    ].join('\n'),
    truth: [
      { span: 'Delphine Okonkwo-Reyes', category: 'PATIENT_NAME' },
      { span: '02/11/1958', category: 'DATE' },
      { span: '40092217', category: 'MRN' },
      { span: 'AC-2026-0447812', category: 'OTHER_ID' },
      { span: 'SP99031877', category: 'OTHER_ID' },
      { span: '09/14/2026', category: 'DATE' },
      { span: 'Tomasz Wierzbicki', category: 'PATIENT_NAME' },
    ],
    decoys: ['80053', '85025', 'E11.9', 'I10', 'serum', '99D9912345'],
    policyDependent: ['1999904413'],
  },
  {
    id: 'req-barcode-line',
    family: 'lab-requisition',
    text: 'Req barcode 7712039944018 | pt Wexford, Annabel | coll 2026-08-30 | 87086 urine culture, 81001 UA | N39.0',
    truth: [
      { span: '7712039944018', category: 'OTHER_ID' },
      { span: 'Wexford, Annabel', category: 'PATIENT_NAME' },
      { span: '2026-08-30', category: 'DATE' },
    ],
    decoys: ['87086', '81001', 'N39.0'],
    policyDependent: [],
  },
  {
    id: 'req-decoys-only',
    family: 'lab-requisition',
    text: 'Panel 80061 lipid panel billed with Z13.220 screening; specimen type plasma; lab CLIA 99D9900077.',
    truth: [],
    decoys: ['80061', 'Z13.220', 'plasma', '99D9900077'],
    policyDependent: [],
  },

  // ── eob-835 ──────────────────────────────────────────────────────────────
  {
    id: 'eob-line',
    family: 'eob-835',
    text: [
      'EXPLANATION OF BENEFITS — Blue Ridge Health Plan',
      'Subscriber: Harlan Vosberg   Member ID: BRH448120937',
      'Patient account #: PA-0088213   Claim control #: 20262451188820',
      'DOS 07/22/2026   CPT 87804 Flu antigen   Billed $64.00   Allowed $38.12   Paid $30.50',
      'Adjustment CARC 45 RARC N130',
    ].join('\n'),
    truth: [
      { span: 'Harlan Vosberg', category: 'PATIENT_NAME' },
      { span: 'BRH448120937', category: 'INSURANCE_ID' },
      { span: 'PA-0088213', category: 'OTHER_ID' },
      { span: '20262451188820', category: 'OTHER_ID' },
      { span: '07/22/2026', category: 'DATE' },
    ],
    decoys: ['Blue Ridge Health Plan', '87804', '$38.12', '$30.50', 'N130'],
    policyDependent: [],
  },
  {
    id: 'eob-flat-835',
    family: 'eob-835',
    text: 'CLP*PA0091772*4*120.00*0*0*12*20262390010442~NM1*QC*1*Lindqvist*Rosamund~SVC*HC:80048*120.00*0~CAS*CO*197*120.00~',
    truth: [
      { span: 'PA0091772', category: 'OTHER_ID' },
      { span: '20262390010442', category: 'OTHER_ID' },
      { span: 'Lindqvist', category: 'PATIENT_NAME' },
      { span: 'Rosamund', category: 'PATIENT_NAME' },
    ],
    decoys: ['80048', '197'],
    policyDependent: [],
  },

  // ── denial-appeal ────────────────────────────────────────────────────────
  {
    id: 'denial-letter',
    family: 'denial-appeal',
    text: [
      'Reference No. DN-55120447-B',
      'Dear Ms. Priyanka Thorsdottir,',
      'Your claim for date of service 06/03/2026 (CPT 81479) was denied under medical policy LAB-2026-114 as not medically necessary (CARC 50).',
      'Sincerely, Claims Review, Meridian Payer Services',
    ].join('\n'),
    truth: [
      { span: 'DN-55120447-B', category: 'OTHER_ID' },
      { span: 'Priyanka Thorsdottir', category: 'PATIENT_NAME' },
      { span: '06/03/2026', category: 'DATE' },
    ],
    decoys: ['81479', 'LAB-2026-114', 'Meridian Payer Services'],
    policyDependent: [],
  },
  {
    id: 'appeal-draft',
    family: 'denial-appeal',
    text: 'Re: appeal of claim 20261880072215 for Gideon Ashworth-Malley, member XKM55091231, DOS 5/19/26. ICD-10 C61 supports CPT 84153 under the payer\'s policy LAB-2025-031.',
    truth: [
      { span: '20261880072215', category: 'OTHER_ID' },
      { span: 'Gideon Ashworth-Malley', category: 'PATIENT_NAME' },
      { span: 'XKM55091231', category: 'INSURANCE_ID' },
      { span: '5/19/26', category: 'DATE' },
    ],
    decoys: ['C61', '84153', 'LAB-2025-031'],
    policyDependent: [],
  },

  // ── provider-ids ─────────────────────────────────────────────────────────
  {
    id: 'provider-block',
    family: 'provider-ids',
    text: 'Billing provider: Cumberland Reference Laboratory, NPI 1999907781, TIN 99-1234567, CLIA 99D9955501. Rendering: Dr. Aurelio Banerjee, NPI 1999902296.',
    truth: [],
    decoys: ['Cumberland Reference Laboratory', '99D9955501'],
    policyDependent: ['1999907781', '99-1234567', 'Aurelio Banerjee', '1999902296'],
  },
];
