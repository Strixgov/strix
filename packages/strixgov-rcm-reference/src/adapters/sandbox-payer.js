/**
 * SandboxPayer — posts to a cleared test/certification endpoint.
 *
 * SAFETY: This is never the filming default and must never point at a
 * production payer/clearinghouse. `makePayerAdapter` only constructs this when
 * RCM_TARGET=sandbox AND RCM_SANDBOX_BASE_URL is set, and config.ts forbids a
 * production target entirely. Read the endpoint's EDI/trading-partner terms
 * before running the failure scenarios against it. See DEMO-SAFETY-BOUNDARY.md.
 *
 * Left as a thin, explicit seam: the real wire call is intentionally not
 * implemented so no one accidentally fires test traffic without reviewing the
 * endpoint's terms and filling this in deliberately.
 */
export class SandboxPayer {
    baseUrl;
    name;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.name = `Sandbox endpoint (${baseUrl})`;
    }
    async submit(_req) {
        throw new Error(`SandboxPayer.submit() is intentionally unimplemented. Wiring a live ` +
            `sandbox/cert endpoint (${this.baseUrl}) is a deliberate step that requires ` +
            `reviewing that endpoint's EDI/trading-partner terms first. ` +
            `See DEMO-SAFETY-BOUNDARY.md. Filming uses RCM_TARGET=mock.`);
    }
}
