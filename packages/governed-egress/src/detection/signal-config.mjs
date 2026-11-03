/**
 * Build the optional second detector (the self-hosted signal worker) from an
 * operator config file, for the proxy CLI.
 *
 * The config names the worker URL and the identity the proxy is PINNED to
 * (model, revision, weights digest, threshold). The bearer token comes from
 * the environment only, never the file or argv. Anything missing or malformed
 * refuses the start: a proxy that believes a second detector is running when
 * it is not would report coverage it does not have.
 *
 * The signal is stricter-only: it can add spans to redact, never remove one
 * the pattern detector found.
 */
import { createHttpDetectionSignal } from './http-signal.mjs';

/**
 * @param {unknown} config parsed JSON: { url, expected, requestTimeoutMs? }
 * @param {{ token?: string, fetchImpl?: typeof fetch }} [options]
 */
export function signalsFromConfig(config, { token, fetchImpl } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('signal config must be a JSON object');
  }
  const { url, expected, requestTimeoutMs } = config;
  if (typeof url !== 'string' || url === '') throw new TypeError('signal config needs a url');
  if (!expected || typeof expected !== 'object') throw new TypeError('signal config needs an expected identity');
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('set STRIX_SIGNAL_TOKEN (32+ characters) for the signal worker');
  }
  return [
    createHttpDetectionSignal({
      url,
      token,
      expected,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    }),
  ];
}
