/**
 * governedAnthropicDocumentRequest — the end-to-end Claude adapter
 * (spec §9): classify → transform if required → verify → policy decision →
 * issue authorization → validate artifact binding → consume authorization →
 * transmit → record → receipt.
 *
 * The caller never receives (and never supplies content directly to) the
 * raw provider client: the transport is constructed here or injected as an
 * opaque `send()`, and it is invoked only from inside the egress gate, on
 * gate-verified bytes. `anthropic.messages.create(...)` never appears in a
 * caller's hands inside this workflow.
 *
 * The capability id is CONTEXT-NEUTRAL by design (spec §3): the governed
 * capability is `ai.external.document.send`; the provider is context. The
 * same pipeline + gate serve any future provider adapter — only the
 * transport differs.
 */
import { governDocumentEgress } from '../../pipeline.mjs';
import { releaseThroughGate } from '../../egress/gate.mjs';
import { buildEgressReceipt } from '../../evidence/receipt.mjs';
import { prefixedHash, sha256Hex } from '../../artifact/hash.mjs';
import { createAnthropicMessagesTransport } from './transport.mjs';

import { governResponse } from '../_shared/govern-response.mjs';
import { responseScanMode } from '../../response/scan-response.mjs';
export { EGRESS_CAPABILITY_ID } from '../../capability.mjs';
import { EGRESS_CAPABILITY_ID } from '../../capability.mjs';
export const ANTHROPIC_DESTINATION = Object.freeze({ provider: 'anthropic', service: 'claude' });

/**
 * @param {{
 *   source: { text?: string, bytes?: Buffer, mimeType?: string, filename?: string },
 *   prompt: string,
 *   purpose?: string,
 *   actor?: string,
 *   policy: object,
 *   deps: { detector, transformer, verifierDetector?, store, evidence, ttlMs?, now? },
 *   transport?: { name: string, send(payload) },  // injectable; defaults to the real Anthropic transport
 * }} input
 */
export async function governedAnthropicDocumentRequest(input) {
  const { source, prompt, purpose = 'document_analysis', actor, policy, deps } = input;
  // A malformed response-scan option refuses before anything is sent.
  responseScanMode(input.scanResponse);
  const destination = ANTHROPIC_DESTINATION;

  const governed = await governDocumentEgress({
    source,
    prompt,
    destination,
    purpose,
    policy,
    actor,
    deps,
  });

  if (governed.outcome === 'DENY') {
    const receipt = buildEgressReceipt({
      capability: EGRESS_CAPABILITY_ID,
      decision: 'DENY',
      reasonCode: governed.reasonCode,
      actor: actor ?? null,
      artifact: governed.artifact,
      transformation: governed.artifact?.transformation ?? null,
      verification: governed.artifact?.verification?.status ? governed.artifact.verification : null,
      destination,
      execution: 'not_attempted',
      disclosureStatus: 'not_disclosed',
      policy,
    });
    return { released: false, decision: 'DENY', reasonCode: governed.reasonCode, detail: governed.detail, receipt };
  }

  // Only construct the real transport when nothing was injected AND we have
  // an authorized release — an unconfigured deployment refuses here with
  // the authorization unspent (kind 'unconfigured' throws at construction).
  const transport = input.transport ?? createAnthropicMessagesTransport();

  const release = await releaseThroughGate({
    store: deps.store,
    evidence: deps.evidence,
    transport,
    authorizationId: governed.authorization.authorizationId,
    artifactText: governed.releaseText,
    prompt: governed.prompt,
    destination,
    purpose,
    now: deps.now,
  });

  const receipt = buildEgressReceipt({
    capability: EGRESS_CAPABILITY_ID,
    decision: release.decision === 'ALLOW' ? governed.outcome : release.decision,
    reasonCode: release.reasonCode ?? null,
    actor: actor ?? null,
    artifact: governed.artifact,
    promptHash: prefixedHash(sha256Hex(governed.prompt)),
    transformation: governed.artifact.transformation ?? null,
    verification: governed.artifact.verification,
    detector: deps.detector?.info ?? null,
    destination,
    authorizationBinding: prefixedHash(governed.authorization.binding),
    execution: release.execution,
    disclosureStatus: release.disclosureStatus,
    policy,
  });

  return {
    released: release.released,
    decision: release.decision === 'ALLOW' ? governed.outcome : 'DENY',
    reasonCode: release.reasonCode ?? null,
    execution: release.execution,
    disclosureStatus: release.disclosureStatus,
    artifact: governed.artifact,
    receipt,
    providerMeta: release.providerMeta ?? null,
    ...(await governResponse(input, governed, release, deps)),
  };
}
