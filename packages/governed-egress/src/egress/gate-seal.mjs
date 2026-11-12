/**
 * The gate seal: the reason the provider transports this package exports are
 * not a way around the gate.
 *
 * `createAnthropicMessagesTransport` and `createOpenAiChatTransport` are
 * public, because integrators configure them (model, base URL, timeout) and
 * hand them to a governed adapter. Before 2026-11-11 a transport's `send()`
 * would transmit whatever it was given to whoever called it, so holding a
 * transport WAS an outbound route with no evaluation, no authorization and no
 * evidence: a supported export that bypassed enforcement.
 *
 * Now a transport transmits only when the call carries GATE_SEND, and only
 * the two gates (`egress/gate.mjs`, `egress/kernel-gate.mjs`) attach it, after
 * every binding check has passed and the grant is consumed. The symbol is
 * created here with `Symbol()` (never `Symbol.for`, which a caller could look
 * up in the global registry), and this module is not reachable from outside:
 * the package's `exports` map does not list it, so `import` of
 * `@strixgov/governed-egress/src/egress/gate-seal.mjs` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * What this does NOT do: stop an integrator calling the provider's own SDK or
 * API directly, outside this package. No library can. It closes the route
 * this package itself offered.
 */
export const GATE_SEND = Symbol('strix-egress.gate-send');

/** Attach the seal to a payload the gate has already checked. */
export function sealForTransport(payload) {
  return { ...payload, [GATE_SEND]: true };
}

/** True only for a payload a gate sealed. */
export function isGateSealed(payload) {
  return payload !== null && typeof payload === 'object' && payload[GATE_SEND] === true;
}
