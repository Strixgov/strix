/**
 * governedOpenAiDocumentRequest — the OpenAI sibling of
 * `../anthropic/index.mjs`'s `governedAnthropicDocumentRequest`.
 *
 * Byte-for-byte the same pipeline composition as the Anthropic adapter,
 * because the pipeline and gate are provider-agnostic by construction: the
 * governed capability id is `ai.external.document.send` regardless of
 * provider (spec §3), and only the transport + destination label differ.
 * This file's entire job is proving that claim rather than merely stating
 * it — see the Anthropic adapter's own header comment, written before this
 * file existed, predicting exactly this addition.
 */
import { governDocumentEgress } from '../../pipeline.mjs';
import { releaseThroughGate } from '../../egress/gate.mjs';
import { buildEgressReceipt } from '../../evidence/receipt.mjs';
import { prefixedHash, sha256Hex } from '../../artifact/hash.mjs';
import { createOpenAiChatTransport } from './transport.mjs';

import { governResponse } from '../_shared/govern-response.mjs';
import { responseScanMode } from '../../response/scan-response.mjs';
export { EGRESS_CAPABILITY_ID } from '../../capability.mjs';
import { EGRESS_CAPABILITY_ID } from '../../capability.mjs';
export const OPENAI_DESTINATION = Object.freeze({ provider: 'openai', service: 'chat-completions' });

/**
 * @param {{
 *   source: { text?: string, bytes?: Buffer, mimeType?: string, filename?: string },
 *   prompt: string,
 *   purpose?: string,
 *   actor?: string,
 *   policy: object,
 *   deps: { detector, transformer, verifierDetector?, store, evidence, ttlMs?, now? },
 *   transport?: { name: string, send(payload) },  // injectable; defaults to the real OpenAI transport
 * }} input
 */
export async function governedOpenAiDocumentRequest(input) {
  const { source, prompt, purpose = 'document_analysis', actor, policy, deps } = input;
  // A malformed response-scan option refuses before anything is sent.
  responseScanMode(input.scanResponse);
  const destination = OPENAI_DESTINATION;

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
  const transport = input.transport ?? createOpenAiChatTransport();

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
