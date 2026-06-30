/**
 * Runtime configuration for the proof kit.
 *
 * The safety boundary (DEMO-SAFETY-BOUNDARY.md) is enforced here: there is no
 * "production" target, and `sandbox` requires an explicit base URL that must
 * be a cleared test endpoint.
 */
export function loadConfig() {
    const raw = (process.env.RCM_TARGET ?? 'mock').toLowerCase();
    if (raw === 'production' || raw === 'prod') {
        throw new Error('RCM_TARGET=production is forbidden. The demo never transacts against a ' +
            'live payer/clearinghouse/EHR. See DEMO-SAFETY-BOUNDARY.md.');
    }
    if (raw !== 'mock' && raw !== 'sandbox') {
        throw new Error(`Unknown RCM_TARGET="${raw}". Use "mock" (default) or "sandbox".`);
    }
    const target = raw;
    const sandboxBaseUrl = process.env.RCM_SANDBOX_BASE_URL?.trim() || null;
    if (target === 'sandbox' && !sandboxBaseUrl) {
        throw new Error('RCM_TARGET=sandbox requires RCM_SANDBOX_BASE_URL pointing at a cleared ' +
            'test/certification endpoint. See DEMO-SAFETY-BOUNDARY.md.');
    }
    return {
        target,
        sandboxBaseUrl,
        kernelUrl: process.env.KERNEL_URL?.trim() || null,
    };
}
