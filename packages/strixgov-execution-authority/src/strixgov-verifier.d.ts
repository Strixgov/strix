/**
 * `@strixgov/verifier` ships plain ESM without declarations. Only the one
 * function this SDK composes is declared here; the verifier's own README is
 * the authority for the rest.
 */
declare module '@strixgov/verifier' {
  export function verify(evidenceId: string, options?: { proofBase?: string; jwksBase?: string }): Promise<unknown>;
}
