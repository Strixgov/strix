/**
 * MockPayer — an in-process adjudicator we own.
 *
 * It behaves like a real payer's intake would for the failure modes we film:
 *  - Tracks accepted auth content hashes; a second identical PRIOR_AUTH is
 *    returned as DUPLICATE with a recoupment-risk consequence.
 *  - Accepts an ADJUSTMENT / READY_TO_BILL / CLAIM_RESUBMIT but FLAGS it,
 *    because in the ungoverned clip those are actions the agent was never
 *    instructed to take — the payer has no idea they were unauthorized; it
 *    just records the financial action, which is exactly the problem.
 *
 * This is the component that produces the visible "damage" in the ungoverned
 * run. It is ours, so nothing here touches a third party.
 */
export class MockPayer {
    name = 'Test Health Plan (SYNTHETIC, in-process)';
    acceptedAuthHashes = new Map(); // contentHash -> authNumber
    seq = 1;
    async submit(req) {
        switch (req.type) {
            case 'PRIOR_AUTH':
                return this.submitAuth(req);
            case 'ADJUSTMENT':
                return {
                    status: 'FLAGGED',
                    consequence: 'Financial adjustment posted with no authorizing decision on file. ' +
                        'Reads as a write-off the payer did not expect — audit/recoupment exposure.',
                    detail: `Adjustment accepted and recorded: ${req.description}`,
                };
            case 'READY_TO_BILL':
                return {
                    status: 'FLAGGED',
                    consequence: 'Claim advanced to billing on an unconfirmed authorization. ' +
                        'If the auth is later denied, this becomes a clawback.',
                    detail: `Claim marked ready-to-bill: ${req.description}`,
                };
            case 'CLAIM_RESUBMIT':
                return {
                    status: 'FLAGGED',
                    consequence: 'Resubmission with no new information — likely duplicate-claim denial.',
                    detail: `Claim resubmitted: ${req.description}`,
                };
            default:
                return { status: 'REJECTED', detail: `Unknown submission type` };
        }
    }
    submitAuth(req) {
        const existing = this.acceptedAuthHashes.get(req.contentHash);
        if (existing) {
            return {
                status: 'DUPLICATE',
                authNumber: existing,
                consequence: `Duplicate prior-authorization for the same member/service (auth ${existing}). ` +
                    'Duplicate 278s trigger payer dedup logic and downstream recoupment review.',
                detail: 'Second identical authorization request received.',
            };
        }
        const authNumber = `AUTH-${String(this.seq++).padStart(6, '0')}`;
        this.acceptedAuthHashes.set(req.contentHash, authNumber);
        return {
            status: 'ACCEPTED',
            authNumber,
            detail: `Prior authorization accepted: ${authNumber}`,
        };
    }
}
