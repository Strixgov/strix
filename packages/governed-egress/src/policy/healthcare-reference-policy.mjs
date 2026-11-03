/**
 * The healthcare reference egress policy (spec §12) — config-as-code for v0.1, shaped
 * to migrate into the Strix policy/control plane at Phase B. The pilot rule,
 * verbatim from the spec: raw PHI never reaches Claude.
 *
 * DEEP-frozen, not merely Object.freeze'd: a shallow freeze left the nested
 * `phi.action` field mutable on a module-level constant, i.e. one write
 * anywhere in the process would have changed the policy for every later
 * caller (found by the 360 probe that also found the pipeline's
 * validated-vs-enforced policy gap; both are fixed together).
 */
import { deepFreeze } from './policy.mjs';

export const HEALTHCARE_REFERENCE_POLICY = deepFreeze({
  policyId: 'healthcare-reference-egress',
  policyVersion: '0.1.0',
  dataEgress: {
    externalAI: {
      default: 'deny',
      phi: {
        action: 'sanitize',
        requirePostTransformVerification: true,
        failClosed: true,
      },
      destinations: {
        anthropic: {
          enabled: true,
          allowedData: ['deidentified', 'non_sensitive'],
        },
      },
    },
  },
});
