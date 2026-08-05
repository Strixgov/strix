/**
 * @strixgov/trust-mark-embed — embeddable <strix-trust-mark> web component
 *
 * Exports the StrixTrustMarkElement and support functions for the consumer
 * trust-mark badge. The element registers as a side effect of import.
 */

/**
 * Trust mark state verdict from the status route.
 * Produced by reduceTrustMarkResponse; rendered by the badge element.
 */
export interface TrustMarkState {
  badge: "GREEN" | "RED" | "YELLOW" | "SLATE";
  grantId: string | null;
  markClass: string | null;
  surfaceOrigin: string | null;
  verificationStatus: string | null;
  verificationReason: string | null;
  coverage: string | null;
  note: string | null;
}

/**
 * HTTP fetch response for trust mark status.
 */
export interface TrustMarkResponse {
  httpStatus?: number;
  body?: Record<string, unknown> | null;
  networkError?: boolean;
}

/**
 * Options for rendering and fetching the trust mark.
 */
export interface TrustMarkOptions {
  proofBase?: string;
  compact?: boolean;
}

/**
 * Web component that renders the <strix-trust-mark> badge.
 * Automatically registers as a custom element when the module is imported.
 *
 * HTML attributes:
 *   grant-id      (required) — the trust-mark grant to resolve
 *   proof-base    (optional) — override the status API base URL
 *   compact       (optional) — render a single inline pill
 *   auto-refresh  (optional, ms ≥ 30000) — re-resolve every N ms
 *
 * Methods:
 *   refresh(): Promise<TrustMarkState | null> — fetch and render the current state
 *
 * Events:
 *   strix-trust-mark:state — emitted when the state changes (detail: TrustMarkState)
 */
export class StrixTrustMarkElement extends HTMLElement {
  /**
   * Fetch and render the current trust mark state for the grant-id.
   * Returns the state object, or null if no grant-id is set.
   */
  refresh(): Promise<TrustMarkState | null>;

  /**
   * Observed attributes that trigger attributeChangedCallback.
   */
  static observedAttributes: string[];
}

/**
 * Default proof API base URL (https://www.strixgov.com)
 */
export const DEFAULT_PROOF_BASE: string;

/**
 * Reduce an HTTP response from the trust mark status route into a render state.
 * Pure function — does not perform any network requests or DOM mutations.
 *
 * @param input - HTTP response data
 * @returns Trust mark state ready for rendering
 */
export function reduceTrustMarkResponse(input?: TrustMarkResponse): TrustMarkState;

/**
 * Fetch the trust mark state from the status route.
 *
 * @param grantId - The trust mark grant ID to resolve
 * @param options - Optional rendering and fetch configuration
 * @returns Trust mark state from the API
 */
export function fetchTrustMarkState(
  grantId: string,
  options?: TrustMarkOptions,
): Promise<TrustMarkState>;

/**
 * Render a trust mark badge as HTML.
 *
 * @param state - The trust mark state to render
 * @param options - Optional rendering configuration
 * @returns HTML string representation of the badge
 */
export function render(state: TrustMarkState, options?: TrustMarkOptions): string;

/**
 * Render a loading placeholder badge.
 *
 * @returns HTML string representation of the loading badge
 */
export function renderLoading(): string;

/**
 * Badge color and label tokens for the four states (GREEN, RED, YELLOW, SLATE).
 */
export const badgeColors: Record<
  "GREEN" | "RED" | "YELLOW" | "SLATE",
  {
    fg: string;
    bg: string;
    dot: string;
    token: string;
  }
>;

/**
 * Human-readable labels for the four badge states.
 */
export const badgeLabel: Record<"GREEN" | "RED" | "YELLOW" | "SLATE", string>;

export default StrixTrustMarkElement;
