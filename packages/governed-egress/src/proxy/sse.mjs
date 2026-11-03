/**
 * Server-sent-event bodies for `stream: true`, in the two wire shapes the
 * proxy speaks.
 *
 * THE DESIGN IS BUFFERED, DELIBERATELY. By the time anything here runs, the
 * provider has answered in full, the response scan has run, a withheld
 * answer has already been turned into a refusal, and re-identification has
 * run over the WHOLE answer. These functions only re-frame text that has
 * already been cleared. So there is no point at which a chunk of an unscanned
 * answer could reach the client, and no point at which a token could be split
 * across chunks before it is restored: restoration happened before the first
 * chunk existed.
 *
 * The chunker still refuses to split inside a token literal (a client that
 * kept tokens, `--no-reidentify`, may restore them itself and should never
 * see `[PATI` / `ENT_001]`) or inside a UTF-16 surrogate pair.
 */
import { randomUUID } from 'node:crypto';
import { TOKEN_PREFIX } from '../detection/categories.mjs';

const TOKEN_LITERAL = new RegExp(String.raw`\[(?:${Object.values(TOKEN_PREFIX).join('|')})_[0-9]{3,}\]`, 'g');

/**
 * Split `text` into pieces of about `size` characters, never inside a token
 * literal or a surrogate pair. Concatenating the pieces returns `text`.
 */
export function chunkForStream(text, size) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isInteger(size) || size < 1) throw new TypeError('size must be a positive integer');
  if (text.length === 0) return [];
  const protectedRanges = [];
  for (const m of text.matchAll(TOKEN_LITERAL)) protectedRanges.push([m.index, m.index + m[0].length]);
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    for (const [a, b] of protectedRanges) {
      if (a < end && end < b) {
        end = b;
        break;
      }
    }
    if (end < text.length) {
      const unit = text.charCodeAt(end - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) end += 1;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const event = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

/** OpenAI Chat Completions stream: `chat.completion.chunk` events, then `[DONE]`. */
export function openAiStreamBody({ model, content, strix, chunkChars }) {
  const id = `strix-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });
  let out = data(chunk({ role: 'assistant', content: '' }, null));
  for (const piece of chunkForStream(content, chunkChars)) out += data(chunk({ content: piece }, null));
  out += data(chunk({}, 'stop', { strix }));
  out += 'data: [DONE]\n\n';
  return out;
}

/**
 * Anthropic Messages stream: message_start, one text content block, deltas,
 * content_block_stop, message_delta, message_stop.
 *
 * `usage` carries the provider's reported counts when the transport returned
 * them, and 0 otherwise — the SDKs require the fields to exist. The `strix`
 * block says which (`usageReported`).
 */
export function anthropicStreamBody({ model, content, strix, chunkChars, usage }) {
  const id = `strix-${randomUUID()}`;
  const inputTokens = Number.isInteger(usage?.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isInteger(usage?.outputTokens) ? usage.outputTokens : 0;
  let out = event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  out += event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of chunkForStream(content, chunkChars)) {
    out += event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
  }
  out += event('content_block_stop', { index: 0 });
  out += event('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
    strix,
  });
  out += event('message_stop', {});
  return out;
}
