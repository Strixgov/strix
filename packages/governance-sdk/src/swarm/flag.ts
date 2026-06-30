/**
 * Agent Swarm v1 — master kill switch.
 *
 * Contract: `docs/architecture/agent-swarm-v1.md` contractVersion 0.2.0.
 *
 * `STRIX_AGENT_SWARM_V1` gates the producer side (the console writers that mint
 * + persist swarm_run / swarm_delegation / swarm_action_evidence rows). Pinned
 * to the exact string "true" — anything else (unset, "1", "yes", "TRUE") is OFF
 * — matching the fail-closed default discipline of `isAgentAttestationFlagOn`
 * (AA-1's `STRIX_ACTOR_ATTESTATION_V1`).
 *
 * The verifier never consults this flag: a signed swarm artifact is verifiable
 * regardless of whether new writes are currently enabled.
 */
export function isAgentSwarmFlagOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STRIX_AGENT_SWARM_V1 === "true";
}
