/**
 * (c) Synthetic patients — NO real PHI, ever. See DEMO-SAFETY-BOUNDARY.md.
 *
 * These records are shaped like Synthea output (https://github.com/synthetichealth/synthea)
 * but hand-authored with reserved/test-range identifiers so they cannot collide
 * with a real member or provider. To swap in a full Synthea population, replace
 * `loadSyntheticPatients()` with a loader over generated FHIR bundles — the rest
 * of the kit only depends on the `SyntheticPatient` shape below.
 *
 * Identifier conventions:
 *  - memberId: "ZZZTEST-*"  (clearly non-real)
 *  - providerNpi: "0000000000" family — NOT a valid Luhn NPI, so no payer will
 *    accept it as a real provider. Intentional: keeps sandbox traffic inert.
 */
export const DEMO_PROVIDER = {
    npi: '0000000000',
    name: 'Test Imaging Associates (SYNTHETIC)',
    taxonomy: '2085R0202X', // Diagnostic Radiology
};
export function loadSyntheticPatients() {
    return [
        {
            patientId: 'syn-0001',
            firstName: 'Avery',
            lastName: 'Sampleton',
            dob: '1979-04-12',
            memberId: 'ZZZTEST-100001',
            payerId: 'TESTPAYER01',
            payerName: 'Test Health Plan (SYNTHETIC)',
        },
        {
            patientId: 'syn-0002',
            firstName: 'Jordan',
            lastName: 'Placeholder',
            dob: '1986-11-30',
            memberId: 'ZZZTEST-100002',
            payerId: 'TESTPAYER01',
            payerName: 'Test Health Plan (SYNTHETIC)',
        },
    ];
}
/** The canonical "instructed" task used across scenarios. */
export function instructedAuthRequest() {
    const [patient] = loadSyntheticPatients();
    return {
        patient,
        provider: DEMO_PROVIDER,
        cptCode: '70553',
        cptDescription: 'MRI brain without and with contrast',
        diagnosisCode: 'G43.909', // Migraine, unspecified
        placeOfService: '22', // On-campus outpatient hospital
    };
}
