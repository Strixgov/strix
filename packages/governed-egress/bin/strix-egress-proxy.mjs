#!/usr/bin/env node
/**
 * strix-egress-proxy — run the governed drop-in proxy.
 *
 *   STRIX_EGRESS_PROXY_TOKEN=<32+ chars> ANTHROPIC_API_KEY=... \
 *     strix-egress-proxy --policy policy.json --provider anthropic [--model M]
 *       [--allow-model M2] [--base-url https://...] [--port 8787] [--host 127.0.0.1 --tls-cert c --tls-key k]
 *       [--evidence-file evidence.jsonl] [--signing-key-file key.pem]
 *       [--withhold-on-findings] [--no-reidentify] [--signal-config worker.json]
 *       [--pack lab-requisition] [--pack eob-835] [--pack denial-appeal]
 *       [--pack provider-ids]
 *
 *   strix-egress-proxy keygen --private-key-out key.pem --public-key-out key.pub.pem
 *   strix-egress-proxy init-policy [policy.json]   write the starter policy (never overwrites)
 *   strix-egress-proxy --help | --version
 *
 * Signed evidence: `keygen` makes an Ed25519 key pair (private key written
 * 0600, never overwritten). With `--signing-key-file` (or the PEM in
 * STRIX_EGRESS_SIGNING_KEY) every evidence record is signed; check a log
 * with `strix-egress-verify-evidence`. Keep the private key where the people
 * who can edit the evidence file cannot read it: a signature only means
 * something if they cannot make one.
 *
 * The token and the provider key come from the environment only, never argv
 * (argv is readable by other processes). Evidence records carry hashes,
 * categories and counts, never values; `--evidence-file` appends them as
 * JSONL, hash-chained.
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { createEgressProxy, PROXY_INFO } from '../src/proxy/server.mjs';
import { signalsFromConfig } from '../src/detection/signal-config.mjs';
import { createPatternDetector } from '../src/detection/pattern-detector.mjs';
import { createEvidenceSigner, generateEvidenceSigningKey, resumePointOf } from '../src/evidence/signing.mjs';

function parseArgs(argv) {
  const out = { allowModel: [], pack: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--policy': out.policy = next(); break;
      case '--provider': out.provider = next(); break;
      case '--model': out.model = next(); break;
      case '--base-url': out.baseUrl = next(); break;
      case '--allow-model': out.allowModel.push(next()); break;
      case '--port': out.port = Number(next()); break;
      case '--host': out.host = next(); break;
      case '--tls-cert': out.tlsCert = next(); break;
      case '--tls-key': out.tlsKey = next(); break;
      case '--evidence-file': out.evidenceFile = next(); break;
      case '--signing-key-file': out.signingKeyFile = next(); break;
      case '--withhold-on-findings': out.withhold = true; break;
      case '--no-reidentify': out.noReidentify = true; break;
      case '--signal-config': out.signalConfig = next(); break;
      case '--pack': out.pack.push(next()); break;
      case '--token': throw new Error('refusing --token: pass it as STRIX_EGRESS_PROXY_TOKEN, never on the command line');
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

function runKeygen(argv) {
  let priv;
  let pub;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === '--private-key-out') priv = v;
    else if (a === '--public-key-out') pub = v;
    else throw new Error(`unknown argument ${a}`);
    i += 1;
  }
  if (!priv || !pub) throw new Error('keygen needs --private-key-out and --public-key-out');
  const key = generateEvidenceSigningKey();
  // 'wx' refuses to overwrite: replacing a signing key by accident would make
  // every record it signed unverifiable to anyone who only has the new key.
  writeFileSync(priv, key.privateKeyPem, { flag: 'wx', mode: 0o600 });
  writeFileSync(pub, key.publicKeyPem, { flag: 'wx', mode: 0o644 });
  process.stdout.write(`${key.keyId}\nprivate key: ${priv} (keep it away from anyone who can edit the evidence file)\npublic key:  ${pub} (give this to whoever verifies the evidence)\n`);
}

function loadSigner(args) {
  const fromEnv = process.env.STRIX_EGRESS_SIGNING_KEY;
  if (args.signingKeyFile && fromEnv) throw new Error('set either --signing-key-file or STRIX_EGRESS_SIGNING_KEY, not both');
  if (!args.signingKeyFile && !fromEnv) return null;
  if (args.signingKeyFile && process.platform !== 'win32' && (statSync(args.signingKeyFile).mode & 0o077) !== 0) {
    process.stderr.write(`warning: ${args.signingKeyFile} is readable by group or others; restrict it (chmod 600)\n`);
  }
  return createEvidenceSigner(args.signingKeyFile ? readFileSync(args.signingKeyFile) : fromEnv);
}

function readEvidenceFile(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`existing evidence file line ${i + 1} is not JSON (a torn write?); rotate the file`);
    }
  });
}

const USAGE = `strix-egress-proxy — governed drop-in proxy for OpenAI and Anthropic APIs

Run:
  STRIX_EGRESS_PROXY_TOKEN=<32+ chars> ANTHROPIC_API_KEY=... \\
    strix-egress-proxy --policy policy.json --provider anthropic|openai
  Clients then use base URL http://127.0.0.1:8787/v1 and the proxy token as their API key.

Options:
  --policy <file>            egress policy JSON (required; see init-policy)
  --provider <name>          anthropic | openai (required)
  --model <m>                default model; --allow-model <m> adds more
  --base-url <https url>     private or regional provider endpoint
  --port <n>                 default 8787
  --host <addr>              default 127.0.0.1; a non-loopback bind needs --tls-cert and --tls-key
  --evidence-file <file>     append hash-chained evidence records (hashes and counts, never values)
  --signing-key-file <pem>   sign evidence records (make a key with: keygen)
  --pack <id>                opt-in detection pack: lab-requisition, eob-835, denial-appeal, provider-ids
  --signal-config <file>     optional second detector (token in STRIX_SIGNAL_TOKEN)
  --withhold-on-findings     refuse an answer that contains new identifiers
  --no-reidentify            return tokens instead of restoring values

Other commands:
  init-policy [file]         write the starter policy (default policy.json; never overwrites)
  keygen --private-key-out <pem> --public-key-out <pem>
  --version

Secrets come from the environment only: STRIX_EGRESS_PROXY_TOKEN, ANTHROPIC_API_KEY or
OPENAI_API_KEY, STRIX_EGRESS_SIGNING_KEY. A clean scan means no findings by this detector,
not that a document contains no PHI.
`;

if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (process.argv[2] === '--version') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${PROXY_INFO.name} ${PROXY_INFO.version} (${pkg.name} ${pkg.version})\n`);
  process.exit(0);
}

if (process.argv[2] === 'init-policy') {
  const extra = process.argv.slice(4);
  const out = process.argv[3] ?? 'policy.json';
  try {
    if (extra.length || out.startsWith('-')) throw new Error('usage: strix-egress-proxy init-policy [file]');
    const starter = readFileSync(new URL('../examples/policy-starter.json', import.meta.url));
    // 'wx' refuses to overwrite: a policy someone already edited is not ours to replace.
    writeFileSync(out, starter, { flag: 'wx' });
    process.stdout.write(`wrote ${out}: default deny, de-identify before release, rescan required, anthropic and openai enabled for de-identified data only\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`init-policy failed: ${err.code === 'EEXIST' ? `${out} already exists` : err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[2] === 'keygen') {
  try {
    runKeygen(process.argv.slice(3));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`keygen failed: ${err.message}\n`);
    process.exit(1);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const signer = loadSigner(args);
  if (signer && !args.evidenceFile) throw new Error('a signing key needs --evidence-file: signed records that are never written prove nothing');
  // Continue the chain of an existing file (a restart) instead of starting a
  // second 'genesis' inside it, and refuse to append to a file that does not
  // verify.
  const evidenceResume = args.evidenceFile ? resumePointOf(readEvidenceFile(args.evidenceFile), signer ?? undefined) : undefined;
  if (!args.policy) throw new Error('--policy is required');
  if (!args.provider) throw new Error('--provider is required (anthropic or openai)');
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
  const proxy = createEgressProxy({
    policy,
    provider: args.provider,
    token: process.env.STRIX_EGRESS_PROXY_TOKEN ?? '',
    model: args.model,
    baseUrl: args.baseUrl,
    allowedModels: args.allowModel,
    reidentify: !args.noReidentify,
    scanResponse: args.withhold ? { onFindings: 'withhold' } : true,
    // Optional second detector (stricter-only). Token from env, never argv.
    // Lab detection packs (--pack, opt-in, add-only) and the optional second
    // detector (stricter-only). An unknown pack id refuses the start.
    deps: {
      ...(args.pack.length ? { detector: createPatternDetector({ packs: args.pack }) } : {}),
      ...(args.signalConfig
        ? { signals: signalsFromConfig(JSON.parse(readFileSync(args.signalConfig, 'utf8')), { token: process.env.STRIX_SIGNAL_TOKEN }) }
        : {}),
    },
    evidenceSigner: signer ?? undefined,
    evidenceResume,
    onEvidence: args.evidenceFile ? (record) => appendFileSync(args.evidenceFile, `${JSON.stringify(record)}\n`) : undefined,
  });
  const tls = args.tlsCert || args.tlsKey
    ? { cert: readFileSync(args.tlsCert), key: readFileSync(args.tlsKey) }
    : null;
  const host = args.host ?? '127.0.0.1';
  const port = args.port ?? 8787;
  await proxy.listen({ port, host, tls });
  process.stdout.write(`${PROXY_INFO.name} ${PROXY_INFO.version} ready on ${tls ? 'https' : 'http'}://${host}:${port} provider ${args.provider}${args.pack.length ? ` packs ${args.pack.join(',')}` : ''}${args.signalConfig ? ' second detector on' : ''}${signer ? ` evidence signed by ${signer.keyId}` : ''}\n`);
} catch (err) {
  process.stderr.write(`refusing to start: ${err.message}\n`);
  process.exit(1);
}
