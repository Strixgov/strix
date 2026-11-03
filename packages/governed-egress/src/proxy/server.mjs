/**
 * A drop-in proxy that speaks the OpenAI Chat Completions and Anthropic
 * Messages wire formats, and runs every request through the governed
 * local-mode release: detect, tokenize, verify, authorize once, release,
 * scan the answer, restore values for the caller.
 *
 * Point an existing client at it (base URL + the proxy's own token as the
 * "API key") and nothing reaches the provider that did not pass the
 * pipeline. There is no pass-through path: a request the pipeline cannot
 * govern is REFUSED by name, never forwarded as-is.
 *
 * WHAT IT ACCEPTS (v0.2), and why the limits are refusals:
 *   - a conversation: any number of user / assistant turns (and, in the
 *     OpenAI shape, later system turns), ending with a user turn, plus an
 *     optional leading system message. Leading system text is the PROMPT,
 *     scanned and refused on any identifier, exactly as before.
 *   - ONE user turn and nothing else is governed exactly as in v0.1: the
 *     user text is the document, byte for byte.
 *   - MORE THAN ONE turn is rendered as a single transcript and that whole
 *     transcript is the governed DOCUMENT. Every turn — earlier user turns,
 *     earlier assistant turns, whether the client kept tokens or restored
 *     values — is detected, tokenized and rescanned in ONE pass, so one
 *     value gets one token in every turn, the authorization binds the exact
 *     transcript bytes, and one re-identification key covers the answer.
 *     Nothing a client sends back is trusted as already governed: a turn the
 *     client re-identified carries raw values again and is governed again.
 *     If any turn cannot be made safe the whole request is refused; a
 *     partially governed conversation is never sent.
 *   - a token literal already in the history (`[PATIENT_001]` from an
 *     earlier request whose answer the client did not restore) is opaque:
 *     this proxy holds no key between requests, so it cannot know what the
 *     literal stood for. It is left as written, never restored, counted in
 *     `strix.conversation.foreignTokens`, and its surface is reserved so a
 *     fresh value never receives the same token.
 *   - `stream: true`. The provider call is not streamed: the answer is
 *     received in full, scanned, withheld or re-identified, and only then
 *     emitted as server-sent events in the client's format. Nothing is
 *     written to the client before the scan has cleared the answer, and
 *     re-identification runs on the whole answer, so a token is never split
 *     before it is restored. The cost is latency: the first byte arrives
 *     when the whole answer is ready.
 *   - text only. Images, files, audio, tool definitions, tool calls, tool
 *     results and thinking blocks refuse by name (`CONTENT_UNSUPPORTED`,
 *     `TOOLS_UNSUPPORTED`); an assistant turn LAST (a prefill) refuses
 *     (`ASSISTANT_PREFILL_UNSUPPORTED`) because a transcript cannot carry it.
 *   - a model the operator allowed. Sampling parameters the governed
 *     transport does not forward (temperature, top_p, …) are NOT silently
 *     honoured: they are named in `strix.ignoredParameters`.
 *
 * WHAT IT NEVER DOES: log a request or response body, store the
 * re-identification key, or accept the provider's API key from a client
 * (the provider key is the proxy's own, from its environment).
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { governedAnthropicDocumentRequest } from '../adapters/anthropic/index.mjs';
import { governedOpenAiDocumentRequest } from '../adapters/openai/index.mjs';
import { createAnthropicMessagesTransport, DEFAULT_ANTHROPIC_MODEL } from '../adapters/anthropic/transport.mjs';
import { createOpenAiChatTransport, DEFAULT_OPENAI_MODEL } from '../adapters/openai/transport.mjs';
import { validateEgressPolicy } from '../policy/policy.mjs';
import { responseScanMode } from '../response/scan-response.mjs';
import { createPatternDetector } from '../detection/pattern-detector.mjs';
import { createTokenizingTransformer } from '../transformation/tokenizing-transformer.mjs';
import { createInMemoryAuthorizationStore } from '../authorization/authorize.mjs';
import { createInMemoryEvidenceLog } from '../evidence/log.mjs';
import { MAX_ARTIFACT_BYTES } from '../artifact/limits.mjs';
import { TOKEN_PREFIX } from '../detection/categories.mjs';
import { openAiStreamBody, anthropicStreamBody } from './sse.mjs';

export const PROXY_INFO = Object.freeze({ name: 'strix-egress-proxy', version: '0.2.0' });
export const MAX_PROXY_BODY_BYTES = MAX_ARTIFACT_BYTES + 64 * 1024;
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_STREAM_CHUNK_CHARS = 64;
const DEFAULT_PROMPT = 'Respond to the message in the document.';

/** The line that opens each turn of a governed transcript. */
export const TRANSCRIPT_MARKER = '<<<STRIX-TURN';
const markerLine = (role) => `${TRANSCRIPT_MARKER} role=${role}>>>`;
export const TRANSCRIPT_INSTRUCTION =
  `The document is a conversation transcript. Each turn begins with a line \`${markerLine('<role>')}\`. ` +
  'Reply as the assistant to the final user turn. Do not repeat the turn lines.';

const PROVIDERS = Object.freeze({
  anthropic: {
    request: governedAnthropicDocumentRequest,
    transport: (model, baseUrl) => createAnthropicMessagesTransport(baseUrl ? { model, baseUrl } : { model }),
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  },
  openai: {
    request: governedOpenAiDocumentRequest,
    transport: (model, baseUrl) => createOpenAiChatTransport(baseUrl ? { model, baseUrl } : { model }),
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
});

// Parameters a client may send that the governed transport does not forward.
const IGNORED = Object.freeze([
  'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop', 'stop_sequences',
  'presence_penalty', 'frequency_penalty', 'seed', 'user', 'metadata', 'logit_bias', 'stream_options',
]);
// Parameters that change what the request IS; each refuses by name.
const REFUSED = Object.freeze({
  tools: 'TOOLS_UNSUPPORTED',
  tool_choice: 'TOOLS_UNSUPPORTED',
  functions: 'TOOLS_UNSUPPORTED',
  function_call: 'TOOLS_UNSUPPORTED',
  n: 'MULTIPLE_CHOICES_UNSUPPORTED',
  response_format: 'RESPONSE_FORMAT_UNSUPPORTED',
});
// Message fields that carry tool traffic. Present (and not null/empty) refuses.
const TOOL_MESSAGE_FIELDS = Object.freeze(['tool_calls', 'function_call', 'tool_call_id']);
// Message fields that carry non-text payloads.
const NON_TEXT_MESSAGE_FIELDS = Object.freeze(['audio']);
// Content part types that carry tool traffic. Any other non-text part —
// named or unknown — refuses as CONTENT_UNSUPPORTED: an unrecognized part is
// never passed on.
const TOOL_PART_TYPES = new Set([
  'tool_use', 'tool_result', 'server_tool_use', 'mcp_tool_use', 'mcp_tool_result',
  'web_search_tool_result', 'code_execution_tool_result', 'function_call', 'function_call_output',
]);

export class ProxyRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProxyRequestError';
    this.status = status;
    this.code = code;
  }
}

const bad = (code, message) => new ProxyRequestError(400, code, message);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw bad('BODY_MALFORMED', 'message content must be a string or an array of content parts');
  }
  const texts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') throw bad('BODY_MALFORMED', 'each content part must be an object');
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    if (TOOL_PART_TYPES.has(part.type)) {
      throw bad('TOOLS_UNSUPPORTED', 'tool blocks are not governed by this proxy');
    }
    throw bad(
      'CONTENT_UNSUPPORTED',
      'message content must be text (images, files, audio, thinking and other non-text parts are not governed by this proxy)',
    );
  }
  return texts.join('\n');
}

const TOKEN_LITERAL = new RegExp(String.raw`\[(?:${Object.values(TOKEN_PREFIX).join('|')})_[0-9]{3,}\]`, 'g');

function hasMarker(text) {
  const needle = TRANSCRIPT_MARKER.toLowerCase();
  return text.toLowerCase().includes(needle) || text.normalize('NFKC').toLowerCase().includes(needle);
}

/**
 * Parse either wire shape into
 * { document, prompt, model, ignored, stream, turns, foreignTokens }.
 * Exported for tests; pure.
 */
export function parseChatRequest(body, shape) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('BODY_MALFORMED', 'request body must be a JSON object');
  for (const [field, code] of Object.entries(REFUSED)) {
    if (!has(body, field)) continue;
    const v = body[field];
    if (field === 'n' && v === 1) continue;
    if (field === 'response_format' && v && v.type === 'text') continue;
    throw bad(code, `\`${field}\` is not supported by the governed proxy`);
  }
  let stream = false;
  if (has(body, 'stream') && body.stream !== undefined && body.stream !== null) {
    if (typeof body.stream !== 'boolean') throw bad('BODY_MALFORMED', '`stream` must be a boolean');
    stream = body.stream;
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw bad('BODY_MALFORMED', '`messages` must be a non-empty array');

  const ignoredMessageFields = new Set();
  const systemParts = [];
  if (shape === 'anthropic' && body.system !== undefined) systemParts.push(textOf(body.system));
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('BODY_MALFORMED', 'each message must be an object');
    for (const f of TOOL_MESSAGE_FIELDS) {
      if (!has(m, f) || m[f] === null || m[f] === undefined) continue;
      if (Array.isArray(m[f]) && m[f].length === 0) continue;
      throw bad('TOOLS_UNSUPPORTED', `\`${f}\` is not supported by the governed proxy`);
    }
    for (const f of NON_TEXT_MESSAGE_FIELDS) {
      if (has(m, f) && m[f] !== null && m[f] !== undefined) {
        throw bad('CONTENT_UNSUPPORTED', `\`${f}\` is not governed by this proxy`);
      }
    }
    for (const k of Object.keys(m)) {
      if (k !== 'role' && k !== 'content' && !TOOL_MESSAGE_FIELDS.includes(k) && !NON_TEXT_MESSAGE_FIELDS.includes(k)) {
        ignoredMessageFields.add(`messages[].${k}`);
      }
    }
    const role = m.role;
    if (role === 'tool' || role === 'function') throw bad('TOOLS_UNSUPPORTED', 'tool messages are not supported by the governed proxy');
    const isSystem = shape === 'openai' && (role === 'system' || role === 'developer');
    if (!isSystem && role !== 'user' && role !== 'assistant') {
      throw bad('ROLE_UNSUPPORTED', 'message role must be user or assistant (or system/developer in the OpenAI shape)');
    }
    if (m.content === null || m.content === undefined) throw bad('BODY_MALFORMED', 'each message needs content');
    const text = textOf(m.content);
    if (isSystem && turns.length === 0) {
      systemParts.push(text);
      continue;
    }
    turns.push({ role: isSystem ? 'system' : role, text });
  }
  if (turns.length === 0) throw bad('BODY_MALFORMED', 'the request has no user message');
  const last = turns[turns.length - 1];
  if (last.role === 'assistant') {
    throw bad('ASSISTANT_PREFILL_UNSUPPORTED', 'the last message must be a user message (an assistant prefill is not supported)');
  }
  if (last.role !== 'user') throw bad('BODY_MALFORMED', 'the last message must be a user message');
  if (last.text.trim().length === 0) throw bad('BODY_MALFORMED', 'the user message is empty');
  // A turn line inside content could forge a turn boundary in the transcript
  // (make a user's words read as the assistant's, or the reverse). Refused,
  // never escaped: an escape is a second grammar for the model to misread.
  for (const t of [...turns.map((x) => x.text), ...systemParts]) {
    if (hasMarker(t)) {
      throw bad('TRANSCRIPT_MARKER_IN_CONTENT', 'message content contains the governed transcript turn marker');
    }
  }

  const system = systemParts.filter((s) => s.trim().length > 0).join('\n\n');
  let document;
  let prompt;
  if (turns.length === 1) {
    // v0.1 behaviour, byte for byte: the one user turn IS the document.
    document = last.text;
    prompt = system.length > 0 ? system : DEFAULT_PROMPT;
  } else {
    document = turns.map((t) => `${markerLine(t.role)}\n${t.text}`).join('\n\n');
    prompt = system.length > 0 ? `${system}\n\n${TRANSCRIPT_INSTRUCTION}` : TRANSCRIPT_INSTRUCTION;
  }
  const foreignTokens = (document.match(TOKEN_LITERAL) ?? []).length;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
  return {
    document,
    prompt,
    model,
    ignored: [...IGNORED.filter((k) => has(body, k)), ...[...ignoredMessageFields].sort()],
    stream,
    turns: turns.length,
    foreignTokens,
  };
}

function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key : null;
}

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_PROXY_BODY_BYTES) {
    throw new ProxyRequestError(413, 'BODY_TOO_LARGE', 'request body exceeds the proxy limit');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_PROXY_BODY_BYTES) {
      req.destroy();
      throw new ProxyRequestError(413, 'BODY_TOO_LARGE', 'request body exceeds the proxy limit');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('BODY_MALFORMED', 'request body is not valid JSON');
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function sendStream(res, shape, input) {
  const body = shape === 'anthropic' ? anthropicStreamBody(input) : openAiStreamBody(input);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  res.end(body);
}

/** Token counts the provider reported, in either provider's vocabulary; null otherwise. */
function reportedUsage(providerMeta) {
  const u = providerMeta?.usage;
  if (!u || typeof u !== 'object') return null;
  const inputTokens = Number.isInteger(u.input_tokens) ? u.input_tokens : Number.isInteger(u.prompt_tokens) ? u.prompt_tokens : null;
  const outputTokens = Number.isInteger(u.output_tokens) ? u.output_tokens : Number.isInteger(u.completion_tokens) ? u.completion_tokens : null;
  return inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens };
}

function errorPayload(shape, code, message, strix) {
  const error = shape === 'anthropic'
    ? { type: 'error', error: { type: 'strix_egress_refusal', code, message } }
    : { error: { type: 'strix_egress_refusal', code, message } };
  return strix ? { ...error, strix } : error;
}

function successPayload(shape, { model, content, strix }) {
  const id = `strix-${randomUUID()}`;
  if (shape === 'anthropic') {
    return { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: content }], stop_reason: 'end_turn', strix };
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    strix,
  };
}

/** The governance facts returned beside an answer. Counts and ids only. */
function strixBlock(result, parsed) {
  return {
    decision: result.decision,
    released: result.released === true,
    execution: result.execution ?? null,
    disclosureStatus: result.disclosureStatus ?? null,
    receiptId: result.receipt?.receiptId ?? result.refusalReceipt?.receiptId ?? null,
    flaggedCategories: result.artifact?.flaggedCategories ?? [],
    responseScan: result.responseScan
      ? {
          mode: result.responseScan.mode,
          status: result.responseScan.status,
          withheld: result.responseScan.withheld,
          categories: result.responseScan.categories ?? [],
          findingsCount: result.responseScan.findingsCount ?? null,
        }
      : null,
    reidentification: result.reidentification
      ? {
          error: result.reidentification.error ?? null,
          restoredOccurrences: result.reidentification.restoredOccurrences ?? 0,
          unknownTokens: result.reidentification.unknownTokens ?? 0,
          nearMissTokens: result.reidentification.nearMissTokens ?? 0,
        }
      : null,
    // How the request was governed, never what it said: the number of turns
    // (1 = the v0.1 single-document path; more = one transcript document),
    // and how many token literals the history already carried, which this
    // proxy cannot resolve and leaves as written.
    conversation: { turns: parsed.turns, foreignTokens: parsed.foreignTokens },
    ignoredParameters: parsed.ignored,
  };
}

/**
 * @param {{
 *   policy: object, provider: 'anthropic'|'openai', token: string,
 *   model?: string, allowedModels?: string[], actor?: string, baseUrl?: string,
 *   reidentify?: boolean, scanResponse?: boolean | { onFindings?: 'flag'|'withhold' },
 *   streamChunkChars?: number,                   // SSE text per event, default 64
 *   transportFor?: (model: string) => object,   // tests inject a fake here
 *   deps?: object, onEvidence?: (record) => void, log?: (line: string) => void,
 *   evidenceSigner?: { keyId: string, sign(entryHash: string): string },
 *   evidenceResume?: { seq: number, headHash: string },
 * }} config
 */
export function createEgressProxy(config) {
  const provider = PROVIDERS[config?.provider];
  if (!provider) throw new TypeError(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (typeof config.token !== 'string' || config.token.length < MIN_TOKEN_LENGTH) {
    throw new TypeError(`token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const policy = validateEgressPolicy(config.policy);
  const scanResponse = config.scanResponse ?? true;
  responseScanMode(scanResponse); // refuse a malformed option at startup
  const model = config.model ?? provider.defaultModel;
  const allowedModels = new Set([model, ...(config.allowedModels ?? [])]);
  const reidentify = config.reidentify ?? true;
  const streamChunkChars = config.streamChunkChars ?? DEFAULT_STREAM_CHUNK_CHARS;
  if (!Number.isInteger(streamChunkChars) || streamChunkChars < 1 || streamChunkChars > 65536) {
    throw new TypeError('streamChunkChars must be an integer between 1 and 65536');
  }
  const actor = config.actor ?? PROXY_INFO.name;
  const log = config.log ?? ((line) => process.stdout.write(`${line}\n`));
  // `baseUrl` is the operator's own provider endpoint (a private or regional
  // deployment). The transport refuses anything but an absolute https URL.
  const transportFor = config.transportFor ?? ((m) => provider.transport(m, config.baseUrl));
  // Construct the real transport once at startup, so a missing or malformed
  // provider key refuses the START rather than failing the first request.
  if (!config.transportFor) {
    for (const m of allowedModels) transportFor(m);
  }

  // `evidenceSigner` (signing.mjs) Ed25519-signs every record with a
  // customer-held key; `evidenceResume` continues an existing file's chain.
  const evidence = config.deps?.evidence
    ?? createInMemoryEvidenceLog({ signer: config.evidenceSigner, resume: config.evidenceResume });
  const observedEvidence = config.onEvidence
    ? {
        append(entry) {
          const record = evidence.append(entry);
          try {
            config.onEvidence(record);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[strix-egress-proxy] evidence mirror failed:', err?.message);
          }
          return record;
        },
        list: () => evidence.list(),
      }
    : evidence;
  const deps = {
    detector: createPatternDetector(),
    // Reserves any token literal already in the text, so a token carried in
    // from an earlier request is never re-minted for a different value.
    transformer: createTokenizingTransformer({ reserveExistingTokens: true }),
    store: createInMemoryAuthorizationStore(),
    ...config.deps,
    evidence: observedEvidence,
  };

  async function handleChat(req, res, shape) {
    if (!tokenMatches(presentedToken(req), config.token)) {
      return send(res, 401, errorPayload(shape, 'UNAUTHORIZED', 'present the proxy token as the API key'));
    }
    const body = await readBody(req);
    const parsed = parseChatRequest(body, shape);
    const requestedModel = parsed.model ?? model;
    if (!allowedModels.has(requestedModel)) {
      throw bad('MODEL_NOT_ALLOWED', 'the requested model is not allowed by this proxy');
    }
    const result = await provider.request({
      source: { text: parsed.document },
      prompt: parsed.prompt,
      purpose: 'proxy_chat',
      actor,
      policy,
      deps,
      transport: transportFor(requestedModel),
      reidentify,
      scanResponse,
    });
    const strix = strixBlock(result, parsed);
    if (result.decision === 'DENY' && result.released !== true) {
      return send(res, 422, errorPayload(shape, result.reasonCode ?? 'REFUSED', result.detail ?? 'the request was refused', strix));
    }
    if (!result.released) {
      return send(res, 502, errorPayload(shape, 'PROVIDER_ERROR', `the provider call did not complete (${result.execution})`, strix));
    }
    if (result.responseScan?.withheld) {
      return send(res, 422, errorPayload(shape, 'RESPONSE_WITHHELD', 'the answer contained identifiers and was withheld', strix));
    }
    const content = reidentify && typeof result.reidentifiedResponse === 'string'
      ? result.reidentifiedResponse
      : result.response ?? '';
    if (parsed.stream) {
      // Every refusal above is a plain JSON error, as the providers do for a
      // stream request. Only an answer that has been scanned (and cleared,
      // in withhold mode) and re-identified reaches this line, and this is
      // the first byte the client receives.
      return sendStream(res, shape, {
        model: requestedModel,
        content,
        strix,
        chunkChars: streamChunkChars,
        usage: reportedUsage(result.providerMeta),
      });
    }
    return send(res, 200, successPayload(shape, { model: requestedModel, content, strix }));
  }

  async function handle(req, res) {
    const path = (req.url ?? '').split('?')[0];
    const shape = path === '/v1/messages' ? 'anthropic' : 'openai';
    try {
      if (req.method === 'GET' && path === '/healthz') {
        return send(res, 200, { ok: true, proxy: PROXY_INFO, provider: config.provider, model });
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages')) {
        return await handleChat(req, res, shape);
      }
      return send(res, 404, errorPayload(shape, 'NOT_FOUND', 'unknown route'));
    } catch (err) {
      if (err instanceof ProxyRequestError) return send(res, err.status, errorPayload(shape, err.code, err.message));
      // Never echo an unexpected error: it may carry request content.
      return send(res, 500, errorPayload(shape, 'INTERNAL_ERROR', 'the proxy could not process the request'));
    } finally {
      log(`${req.method} ${path} ${res.statusCode}`);
    }
  }

  return {
    handle,
    evidence: observedEvidence,
    /** Start listening. Plain HTTP binds loopback only; anything else needs TLS. */
    listen({ port = 8787, host = '127.0.0.1', tls = null } = {}) {
      const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
      if (!loopback && !tls) throw new TypeError('a non-loopback bind needs TLS (cert and key)');
      const server = tls ? createHttpsServer(tls, handle) : createHttpServer(handle);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      });
    },
  };
}
