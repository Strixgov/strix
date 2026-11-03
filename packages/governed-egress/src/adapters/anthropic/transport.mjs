/**
 * The real Anthropic Messages API transport — the ONLY module in this
 * package that talks to a provider.
 *
 * Rules it holds:
 *  - The API key comes from configuration/environment, is never logged,
 *    never enters evidence, and never appears on any result object.
 *  - An unconfigured transport throws kind 'unconfigured' at CONSTRUCTION,
 *    before any pipeline work, and provably before any I/O. A malformed
 *    `baseUrl` (not an absolute https:// URL) throws the SAME kind, for the
 *    same reason: `destination.provider`/`service` recorded on the
 *    commitment, evidence and receipt are a caller-asserted LABEL, not a
 *    check against where bytes actually travel — nothing anywhere compares
 *    them to the transport's real `endpoint.baseUrl`. An unvalidated
 *    `baseUrl` would let a misconfigured or malicious value silently
 *    reroute every governed release while every signed record still read
 *    "provider: anthropic". https-only, no fallback, never derived from a
 *    request — the STRIX_WEBAUTHN_ORIGINS / STRIX_AA2_ISSUER precedent.
 *  - The wire message is composed HERE from exactly the two gate-verified
 *    pieces (documentText + prompt) in a fixed template. A caller cannot
 *    inject additional content into the request body — there is no
 *    parameter for it.
 *  - A timeout throws kind 'timeout' (the gate maps it to execution
 *    'unknown' / possibly_disclosed); a non-2xx response throws kind
 *    'http' with the status and a BOUNDED one-line body snippet (the
 *    diagnosability lesson: the body is the only thing distinguishing two
 *    401s, and an unreadable body must never mask the refusal).
 *  - `testConnection()` is a credential readiness probe and lives here for
 *    one reason: this is where the credential already is. A probe built in
 *    a product or UI layer would be a second implementation of provider
 *    authentication, and would put a credential within reach of a layer
 *    whose job is building response objects. It sends no body, returns an
 *    observation rather than a verdict, and never throws on a status.
 */
import { checkTransportBaseUrl } from '../_shared/base-url.mjs';

export class TransportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind; // 'unconfigured' | 'timeout' | 'network' | 'http'
  }
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

/** The provider's API version this transport speaks. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

function composeUserContent({ documentText, prompt }) {
  return `${prompt}\n\n<document>\n${documentText}\n</document>`;
}

export function createAnthropicMessagesTransport({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = DEFAULT_ANTHROPIC_MODEL,
  maxTokens = 1024,
  baseUrl = 'https://api.anthropic.com',
  timeoutMs = 60_000,
  // A readiness probe is answered on a setup screen. Waiting a release's
  // full minute there tells the operator nothing they will stay to read.
  probeTimeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TransportError('unconfigured', 'ANTHROPIC_API_KEY is not set — the transport refuses to construct');
  }
  // The resolved endpoint is the one thing about "where this release goes"
  // that nothing downstream re-derives — `destination.provider`/`service`
  // are an asserted label, never compared to this value. So the guard has
  // to live here, at the one place the real destination is decided.
  // One rule, two error surfaces: the check lives in `../_shared/base-url.mjs`
  // so the sibling transport cannot drift away from it, while the refusal
  // stays this transport's own `TransportError('unconfigured')`. It rejects a
  // credential-bearing URL as well as a non-https one — see that module for
  // why the evidence path makes userinfo a live leak rather than a nicety.
  const baseUrlCheck = checkTransportBaseUrl(baseUrl);
  if (!baseUrlCheck.ok) {
    throw new TransportError('unconfigured', `${baseUrlCheck.reason} — the transport refuses to construct`);
  }
  return {
    name: 'anthropic-messages',
    model,
    // Where this transport ACTUALLY sends, reported off the resolved
    // configuration rather than as a constant a second reader could copy.
    // A readiness probe that hardcoded an endpoint would be testing a
    // different destination than the release path uses the moment
    // `baseUrl` is overridden anywhere — two answers to one question. The
    // API KEY is deliberately absent: this object is handed to callers, so
    // anything on it can be read, and a credential is never a description.
    endpoint: Object.freeze({ baseUrl, apiVersion: ANTHROPIC_API_VERSION }),
    /**
     * A readiness probe: does the provider accept this deployment's
     * credential? OPTIONAL on the transport contract, and the optionality is
     * the control — a caller cannot probe a transport that does not offer
     * this, so a relay or a capturing test double is reported unsupported
     * rather than probed at a guessed address with a guessed credential.
     *
     * IT LIVES HERE BECAUSE THE CREDENTIAL LIVES HERE. A probe implemented
     * in a product/UI layer would be a SECOND implementation of provider
     * authentication — the same defect class as a second answer to "where do
     * we send", and it would put a credential in the reach of a layer whose
     * whole job is building response objects. This method composes the same
     * auth headers `send` does, from the same closed-over key, so the probe
     * authenticates exactly the way a release does or not at all.
     *
     * IT SENDS NO BODY AND NO CONTENT. `GET /v1/models` requires the
     * credential and produces no completion — no artifact in the customer's
     * world, no money moved, no document transmitted. There is no parameter
     * through which content could be supplied.
     *
     * IT RETURNS AN OBSERVATION, NEVER A VERDICT, AND NEVER THROWS ON A
     * STATUS. `send` throws on a non-2xx because for a release that IS the
     * failure; for a probe a 401 is the ANSWER, and turning it into an
     * exception would hand the classification to whatever try/catch happened
     * to be nearest. The caller decides what each status means.
     */
    async testConnection() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
      const probedUrl = `${baseUrl}/v1/models`;
      let res;
      try {
        res = await fetchImpl(probedUrl, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          signal: controller.signal,
        });
      } catch (err) {
        // Timeout and refusal are different facts: one may have reached the
        // provider, the other provably did not.
        const aborted = err?.name === 'AbortError';
        return Object.freeze({
          reached: false,
          kind: aborted ? 'timeout' : 'network',
          detail: aborted ? `no answer within ${probeTimeoutMs}ms` : String(err?.message ?? err),
          probedUrl,
        });
      } finally {
        clearTimeout(timer);
      }

      let bodySnippet = null;
      if (!res.ok) {
        // Where the provider says WHY — "your credit balance is too low"
        // lives here, and it is the only thing distinguishing two 401s.
        try {
          bodySnippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 300) || null;
        } catch {
          bodySnippet = '<body unreadable>';
        }
      }
      return Object.freeze({ reached: true, status: res.status, bodySnippet, probedUrl });
    },
    async send({ documentText, prompt }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: composeUserContent({ documentText, prompt }) }],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw new TransportError('timeout', `no response within ${timeoutMs}ms — the request may have reached the provider`);
        }
        throw new TransportError('network', String(err?.message ?? err));
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        let snippet = '<body unreadable>';
        try {
          snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
          // keep the placeholder — an unreadable body never masks the refusal
        }
        throw new TransportError('http', `Anthropic API ${res.status} ${res.statusText} — ${snippet}`);
      }

      const body = await res.json();
      const responseText = Array.isArray(body?.content)
        ? body.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : '';
      return {
        ok: true,
        responseText,
        providerMeta: {
          provider: 'anthropic',
          service: 'claude',
          model: body?.model ?? model,
          requestId: res.headers?.get?.('request-id') ?? null,
          stopReason: body?.stop_reason ?? null,
          usage: body?.usage ?? null,
        },
      };
    },
  };
}
