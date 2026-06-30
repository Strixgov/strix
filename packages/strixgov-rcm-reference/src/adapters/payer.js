/**
 * (b) Payer adapter interface + factory.
 *
 * Two implementations:
 *  - MockPayer   : an in-process adjudicator we own. Default. The only target
 *                  used for filming. It is what reacts (denial / duplicate flag /
 *                  recoupment) in the ungoverned clip.
 *  - SandboxPayer: posts to a cleared test/certification endpoint. Never the
 *                  filming default; gated by config. See DEMO-SAFETY-BOUNDARY.md.
 *
 * There is deliberately no production adapter.
 */
export async function makePayerAdapter(config) {
    if (config.target === 'sandbox') {
        const { SandboxPayer } = await import('./sandbox-payer.js');
        return new SandboxPayer(config.sandboxBaseUrl);
    }
    const { MockPayer } = await import('./mock-payer.js');
    return new MockPayer();
}
