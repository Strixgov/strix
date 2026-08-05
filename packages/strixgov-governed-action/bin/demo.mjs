#!/usr/bin/env node
/**
 * `npx @strixgov/governed-action demo`
 *
 * The zero-code path: one command, from nothing installed to a verify command
 * you can run yourself. This is the leg Time-to-First-Proof actually measures,
 * so it prints its own elapsed time.
 *
 * HONESTY BOUNDARY, printed in-band on every run: the governance is real — a
 * real kernel decision, a real Ed25519-signed receipt, a real evidenceId that
 * `npx @strixgov/verifier` resolves independently — but the SIDE EFFECT is
 * simulated. The demo does not merge a pull request or move money. It proves the
 * governance mechanism end-to-end, not that a business action occurred. Saying
 * otherwise would be the demo-room failure mode the doctrine names.
 *
 * `--self-check` runs the identical flow against an in-process server instead of
 * the hosted kernel, so the wiring is verifiable offline and in CI. It prints no
 * TTFP figure, because a loopback round-trip is not the stranger's path.
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'demo';
const selfCheck = args.includes('--self-check');
const json = args.includes('--json');

if (args.includes('--help') || args.includes('-h') || (cmd !== 'demo' && cmd !== 'self-check')) {
  process.stdout.write(`
@strixgov/governed-action — govern one consequential mutation

  npx @strixgov/governed-action demo               run one governed action, print the verify command
  npx @strixgov/governed-action demo --self-check  same flow against a local server (offline, no TTFP figure)
  npx @strixgov/governed-action demo --json        machine-readable result

Environment (all optional — a sandbox credential auto-provisions without them):
  STRIX_API_KEY, STRIX_TENANT_ID, STRIX_API_URL, STRIX_ACTOR
`);
  process.exit(0);
}

const { governedAction, resolveCapability } = await import('../dist/index.js');

/** The capability the demo declares. Real, registered, and genuinely irreversible. */
const CAPABILITY = 'filesystem.delete';

const c = {
  dim: (s) => `[2m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  amber: (s) => `[33m${s}[0m`,
  cyan: (s) => `[36m${s}[0m`,
};
const plain = !process.stdout.isTTY || json;
const paint = plain
  ? Object.fromEntries(Object.keys(c).map((k) => [k, (s) => s]))
  : c;

function step(n, text) {
  if (!json) process.stdout.write(`${paint.dim(`[${n}/4]`)} ${text}\n`);
}

/** A local stand-in used only by --self-check. */
async function startLocalKernel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = req.url ?? '';
      let out = { status: 404, body: {} };
      if (url.endsWith('/api/public/sandbox/provision')) {
        out = { status: 200, body: { apiKey: 'self-check-key', tenantId: 'self-check-tenant' } };
      } else if (url.endsWith('/api/v1/evaluate')) {
        out = { status: 200, body: { action: 'allow', decisionId: 'dec_self_check' } };
      } else if (url.endsWith('/api/v1/evidence/ingest')) {
        out = { status: 200, body: { ingested: 1, skipped: 0 } };
      } else if (url.includes('/receipt')) {
        out = { status: 200, body: { evidenceId: 'ev_self_check', proofUrl: 'http://127.0.0.1/proof/ev_self_check' } };
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

let local = null;
const started = Date.now();

try {
  if (selfCheck) local = await startLocalKernel();

  if (!json) {
    process.stdout.write(`\n${paint.bold('Strix — one governed action')}\n`);
    process.stdout.write(paint.dim(selfCheck
      ? 'self-check: local server, offline. Not a TTFP measurement.\n\n'
      : 'Real decision, real signed receipt. Simulated side effect.\n\n'));
  }

  step(1, `Declaring capability ${paint.cyan(CAPABILITY)}`);
  const resolved = resolveCapability(CAPABILITY, []);
  if (!json && resolved.qualification.status === 'UNKNOWN') {
    process.stdout.write(paint.dim(
      '      not classified locally — pass @strixgov/capabilities-* to classify it\n'));
  }

  step(2, 'Asking the kernel for a decision, then running the operation');

  const { signedEvidenceId, proofUrl, verifyCommand, decisionId } = await governedAction(
    {
      capabilityId: CAPABILITY,
      payload: {
        path: '/tmp/strix-demo/report.csv',
        note: 'governance-mechanism demo; no file is deleted and no business action occurred',
      },
      ...(local ? { strixUrl: local.base } : {}),
    },
    // The simulated side effect. Deliberately does nothing irreversible.
    async () => ({ simulated: true, deleted: false }),
  );

  step(3, 'Evidence recorded');
  step(4, signedEvidenceId ? 'Receipt signed' : 'Receipt unavailable');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (json) {
    process.stdout.write(JSON.stringify({
      capabilityId: CAPABILITY,
      decisionId,
      signedEvidenceId,
      proofUrl,
      verifyCommand,
      elapsedSeconds: Number(elapsed),
      selfCheck,
      sideEffect: 'simulated',
    }, null, 2) + '\n');
  } else if (verifyCommand) {
    process.stdout.write(`\n${paint.green('✓')} Signed receipt ${paint.bold(signedEvidenceId)}\n`);
    if (proofUrl) process.stdout.write(`  ${paint.dim(proofUrl)}\n`);
    process.stdout.write(`\n${paint.bold('Verify it yourself — nothing of ours on the trust path:')}\n`);
    process.stdout.write(`\n  ${paint.cyan(verifyCommand)}\n\n`);
    if (!selfCheck) {
      process.stdout.write(paint.dim(`  ${elapsed}s to a signed receipt.\n`));
    }
    process.stdout.write(paint.dim(
      '  The decision and receipt are real. The side effect was simulated —\n' +
      '  no file was deleted. This proves the governance path, not a business action.\n\n'));
  } else {
    process.stdout.write(`\n${paint.amber('!')} The action ran and evidence was recorded, but no signed\n`);
    process.stdout.write('  receipt came back, so there is nothing to verify yet.\n');
    process.stdout.write(paint.dim('  Nothing is fabricated to fill the gap — retry, or check connectivity.\n\n'));
    process.exitCode = 1;
  }
} catch (err) {
  const name = err?.name ?? 'Error';
  const msg = err?.message ?? String(err);
  if (json) {
    process.stdout.write(JSON.stringify({ error: name, message: msg }, null, 2) + '\n');
  } else {
    process.stderr.write(`\n${paint.amber('✗')} ${paint.bold(name)}: ${msg}\n`);
    if (name === 'StrixDenied' || name === 'StrixApprovalRequired') {
      process.stderr.write(paint.dim('  The operation did NOT run. That is the system working.\n\n'));
    } else if (name === 'StrixUnreachable') {
      process.stderr.write(paint.dim('  Failed closed — the operation did NOT run.\n' +
        '  Try --self-check to verify the wiring without network.\n\n'));
    } else {
      process.stderr.write('\n');
    }
  }
  process.exitCode = 1;
} finally {
  local?.close();
}
