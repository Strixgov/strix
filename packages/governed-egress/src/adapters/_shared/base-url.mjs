/**
 * The ONE rule for what a provider transport's `baseUrl` may be.
 *
 * Both provider transports are deliberate field-for-field mirrors of each
 * other, and each throws its own `TransportError`. The RULE, though, is not
 * something two implementations should hold separately: a guard that exists
 * twice is a guard that can disagree with itself, and the half that drifts is
 * the half nobody is looking at. So the rule lives here once and returns a
 * reason; the transports keep their own error type and kind.
 *
 * WHY THIS IS MORE THAN AN https:// CHECK
 * ───────────────────────────────────────
 * `types.d.ts` already promises, of the `endpoint` object built from this
 * value, that it "Never carries a credential". Nothing enforced it. A URL may
 * carry userinfo — `https://user:secret@proxy.example` — and that form passes
 * a protocol-only check cleanly. The resolved `baseUrl` is then published on
 * `adapter.endpoint`, and `kernel-gate.mjs`'s `endpointFields` copies that
 * object verbatim into BOTH the attempt and the outcome evidence entries,
 * before the request is even sent. So a proxy credential would be written
 * into the evidence log by the very field added to make the real destination
 * visible — and it would persist there even if `fetch` went on to reject the
 * credential-bearing URL.
 *
 * Refusal, not sanitisation, for the same reason the protocol check refuses:
 * a sanitised record keeps the credential live on the wire while making the
 * evidence look clean, which is the worse of the two failures. Refusing at
 * CONSTRUCTION means the invariant holds everywhere `endpoint` is later read,
 * rather than at whichever single site remembered to redact.
 *
 * A query or fragment is refused for a second, independent reason: this value
 * has a path appended to it (`${baseUrl}/v1/...`), so `https://h?k=v` does not
 * describe a working base URL at all. It is a correctness refusal that also
 * happens to close a place secrets are conventionally carried.
 *
 * THE REFUSAL MESSAGE MUST NOT ECHO THE SECRET. These messages reach logs.
 * A parsed URL is therefore reported in a redacted, origin-and-path form, and
 * the presence of a query or fragment is reported without its contents.
 */

/** Render a parsed URL without userinfo, query, or fragment. */
function redact(url) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * @param {unknown} baseUrl
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkTransportBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    // Unparseable: there is no structure to redact, and naming the value is
    // the entire content of a configuration error. Unchanged from the
    // original behaviour so this fix does not quietly alter an unrelated path.
    return { ok: false, reason: `baseUrl must be an absolute URL; got ${JSON.stringify(baseUrl)}` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `baseUrl must be https://; got ${JSON.stringify(redact(url))}` };
  }
  if (url.username !== '' || url.password !== '') {
    // Deliberately does NOT print the value, not even partially: this branch
    // exists precisely because the value contains a credential.
    return {
      ok: false,
      reason:
        `baseUrl must not carry credentials in the URL (got userinfo on ${JSON.stringify(redact(url))}) — ` +
        'the resolved baseUrl is published on adapter.endpoint and copied into evidence, ' +
        'so a credential here would be written to the evidence log',
    };
  }
  if (url.search !== '' || url.hash !== '') {
    const parts = [url.search !== '' && 'a query string', url.hash !== '' && 'a fragment'].filter(Boolean);
    return {
      ok: false,
      reason:
        `baseUrl must not carry ${parts.join(' or ')} (on ${JSON.stringify(redact(url))}) — ` +
        'a request path is appended to this value, so it would not address the provider',
    };
  }
  return { ok: true, url };
}
