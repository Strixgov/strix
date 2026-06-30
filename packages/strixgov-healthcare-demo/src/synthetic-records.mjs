// Synthetic clinical-data record generator.
//
// All names, dates, conditions, dosages, and identifiers in this file
// are FICTIONAL. They are deliberately implausible-as-real (combining
// uncommon names with implausible birth years etc.) so a reviewer can
// confirm at a glance that no real PHI is present.
//
// This module is the input layer for the demo's clinical workflow.

const FICTIONAL_NAMES = [
  { first: "Quintessa", last: "Aethelwood" },
  { first: "Bartholomew", last: "Pemberton-Vex" },
  { first: "Yarrow", last: "Sterling-Hyde" },
  { first: "Cornelius", last: "Featherwick" },
  { first: "Marigold", last: "Thistlewine" },
];

const FICTIONAL_CONDITIONS = [
  {
    condition: "post-op day 3, mild edema",
    bp: "132/84",
    note: "Continue lisinopril 10mg.",
  },
  {
    condition: "stable angina, follow-up",
    bp: "118/76",
    note: "Cleared for moderate exercise; recheck in 6 weeks.",
  },
  {
    condition: "atrial fibrillation, rate-controlled",
    bp: "126/80",
    note: "Maintain anticoagulation. Next INR in 14 days.",
  },
];

const FICTIONAL_DOBS = [
  "04 / 17 / 1962",
  "11 / 03 / 1958",
  "08 / 22 / 1971",
];

const FICTIONAL_MRNS = ["MRN-FX9-1042", "MRN-7K-2218", "MRN-Q3-8806"];

/**
 * Generate a synthetic patient submission as it would appear in a
 * clinical AI agent intake form.
 *
 * @param {number} [seed] — index into the fictional pools for deterministic
 *                          output (helpful for the demo replay)
 */
export function buildSyntheticSubmission(seed = 0) {
  const idx = ((seed % FICTIONAL_NAMES.length) + FICTIONAL_NAMES.length) %
    FICTIONAL_NAMES.length;
  const name = FICTIONAL_NAMES[idx];
  const dob = FICTIONAL_DOBS[idx % FICTIONAL_DOBS.length];
  const cond = FICTIONAL_CONDITIONS[idx % FICTIONAL_CONDITIONS.length];
  const mrn = FICTIONAL_MRNS[idx % FICTIONAL_MRNS.length];

  return {
    actor: {
      id: "user:dr-rivera",          // ✱ Fictional clinician identity
      role: "physician.cardiology",
      authenticatedAt: new Date().toISOString(),
    },
    capability: "clinical.note.submit",
    payload: {
      patientName: `${name.first} ${name.last}`,
      dob,
      mrn,
      note: `${cond.condition}. BP ${cond.bp}. ${cond.note}`,
    },
    metadata: {
      portal: "care-portal.demo",
      sessionId: `demo-${Date.now()}-${seed}`,
      fictionalDataWarning: "All fields are synthetic. No real PHI.",
    },
  };
}

/**
 * Classify the synthetic submission and produce the redacted payload
 * a HIPAA-aware AI agent would emit to its model.
 *
 * Real HIPAA "Safe Harbor" de-identification (§164.514(b)(2)) requires
 * removing 18 specified identifiers. The demo applies a subset for
 * illustration:
 *   - patient name → redacted to "[REDACTED]"
 *   - DOB year → bucketed into a 10-year age range
 *   - MRN → kept but tokenized (real implementations would hash it)
 */
export function classifyAndRedact(submission) {
  const original = submission.payload;

  // Compute the age bucket from the fictional DOB. We use a 10-year
  // bracket which is what HIPAA Safe Harbor permits without expert
  // determination (45 CFR §164.514(b)(2)(B)).
  const dobMatch = original.dob.match(/(\d{4})/);
  const birthYear = dobMatch ? parseInt(dobMatch[1], 10) : null;
  const now = new Date().getFullYear();
  const age = birthYear ? now - birthYear : null;
  const ageBracket = age
    ? `${Math.floor(age / 10) * 10}-${Math.floor(age / 10) * 10 + 9}`
    : "unknown";

  // Tokenize the MRN. Real implementations would use a keyed hash;
  // for the demo we just truncate.
  const mrnToken = original.mrn ? `${original.mrn.slice(0, 4)}…` : "—";

  const redacted = {
    patientName: "[REDACTED]",
    ageBracket,
    mrnToken,
    note: original.note, // notes themselves are clinical content; not redacted
  };

  // Compute the "minimum necessary" classification result. In a real
  // implementation, this would run a PHI classifier over the note.
  // Here we trust the schema.
  const classification = {
    phiPresent: true,
    fieldsRedacted: ["patientName", "dob", "mrn"],
    fieldsRetained: ["note", "ageBracket", "mrnToken"],
    minNecessaryApplied: true,
  };

  return { redacted, classification };
}
