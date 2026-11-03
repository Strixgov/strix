/**
 * The real OpenAI Chat Completions transport — mirrors
 * `../anthropic/transport.mjs` field-for-field. This is the SECOND provider
 * transport in the tree, and its existence is the proof the pipeline is
 * provider-agnostic by construction (see `../anthropic/index.mjs`'s own
 * header comment) rather than merely documented as such.
 *
 * Same rules as the Anthropic transport, restated because they are not
 * optional for a second implementation to inherit correctly:
 *  - The API key comes from configuration/environment, is never logged,
 *    never enters evidence, and never appears on any result object.
 *  - An unconfigured transport throws kind 'unconfigured' at CONSTRUCTION,
 *    before any pipeline work, and provably before any I/O. A malformed
 *    `baseUrl` throws the SAME kind, for the SAME reason this repo's own
 *    history already records for the sibling transport: `destination`
 *    recorded on the commitment/evidence/receipt is a caller-asserted
 *    LABEL, never compared to where bytes actually travel — so an
 *    unvalidated `baseUrl` would let a misconfigured or malicious value
 *    silently reroute every governed release while every signed record
 *    still read "provider: openai". https-only, no fallback, never derived
 *    from a request.
 *  - The wire message is composed HERE from exactly the two gate-verified
 *    pieces (documentText + prompt) in a fixed template. A caller cannot
 *    inject additional content into the request body — there is no
 *    parameter for it.
 *  - A timeout throws kind 'timeout'; a non-2xx response throws kind
 *    'http' with the status and a BOUNDED one-line body snippet.
 *  - `testConnection()` is a credential readiness probe and lives here for
 *    the same reason the sibling's does: this is where the credential
 *    already is. It sends no chat content and never throws on a status.
 */
import { checkTransportBaseUrl } from '../_shared/base-url.mjs';

export class TransportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind; // 'unconfigured' | 'timeout' | 'network' | 'http'
  }
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

function composeUserContent({ documentText, prompt }) {
  return `${prompt}\n\n<document>\n${documentText}\n</document>`;
}

export function createOpenAiChatTransport({
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_OPENAI_MODEL,
  maxTokens = 1024,
  baseUrl = 'https://api.openai.com',
  timeoutMs = 60_000,
  probeTimeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TransportError('unconfigured', 'OPENAI_API_KEY is not set — the transport refuses to construct');
  }
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
    name: 'openai-chat-completions',
    model,
    // Same discipline as the sibling transport: reported off the RESOLVED
    // configuration, never a hardcoded constant, and never carries the key.
    endpoint: Object.freeze({ baseUrl }),
    async testConnection() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
      const probedUrl = `${baseUrl}/v1/models`;
      let res;
      try {
        res = await fetchImpl(probedUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
      } catch (err) {
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
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            // `max_completion_tokens`, NOT the deprecated `max_tokens`.
            // Chat Completions REJECTS `max_tokens` outright for the model
            // this transport defaults to, so the shipped default would have
            // taken an HTTP 400 on its first real release rather than
            // completing one — a failure no mock fetch would surface,
            // because a test double accepts whichever field it is handed.
            // Sent unconditionally rather than chosen from a model→field
            // table: a table is a second source of truth about OpenAI's
            // model families that goes stale silently, and this repo's own
            // record is that a hardcoded id going stale IS the failure.
            max_completion_tokens: maxTokens,
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
        throw new TransportError('http', `OpenAI API ${res.status} ${res.statusText} — ${snippet}`);
      }

      const body = await res.json();
      const responseText = Array.isArray(body?.choices)
        ? body.choices.map((c) => c?.message?.content ?? '').join('\n')
        : '';
      return {
        ok: true,
        responseText,
        providerMeta: {
          provider: 'openai',
          service: 'chat-completions',
          model: body?.model ?? model,
          requestId: res.headers?.get?.('x-request-id') ?? null,
          finishReason: Array.isArray(body?.choices) ? (body.choices[0]?.finish_reason ?? null) : null,
          usage: body?.usage ?? null,
        },
      };
    },
  };
}
