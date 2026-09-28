/**
 * The reference adapter: one governed execution, end to end.
 *
 *   result = await redeem(authority, currentExecution)
 *   if (result.status !== 'PERMIT') the handler MUST NOT execute
 *
 * `executeGoverned` is that rule as code. The handler is invoked in exactly
 * one place, inside the PERMIT branch, after Strix has atomically consumed the
 * grant for the execution presented at that moment. Every other outcome
 * (REFUSE, REQUIRE_APPROVAL, UNAVAILABLE, a malformed grant, an expired one, a
 * replay, a mutation, a lost signing dependency) returns with
 * `handlerEntered: false` and the handler untouched.
 *
 * `currentExecution` is re-read at the boundary, not at proposal time: the
 * commitments a consumer presents must describe the bytes the handler is
 * about to act on and the standing it just read. That closes the gap between
 * "authority was granted" and "authority is spent": if either changed, the
 * presented execution differs, and the grant does not cover it.
 *
 * What this adapter cannot guarantee is stated in the package README: it
 * governs the handler it is given. Code that reaches the consequence by
 * another path, and a handler that ignores the outcome it returns, are
 * outside it. Strix does not control arbitrary external code.
 */
import type { StrixExecutionAuthorityClient, EvaluateResult, RedeemResult, OutcomeResult } from './client.js';
import { currentExecutionOf, type CurrentExecution, type GrantPayload, type ProposedExecution, type SignedGrant } from './contract.js';

export type GovernedOutcome<T> =
  | { status: 'PERMIT'; handlerEntered: true; grant: GrantPayload; strixDecisionId: string; result: T; outcome: OutcomeResult | { status: 'UNREPORTED'; error: string } }
  | { status: 'PERMIT_HANDLER_FAILED'; handlerEntered: true; grant: GrantPayload; strixDecisionId: string; error: string; outcome: OutcomeResult | { status: 'UNREPORTED'; error: string } }
  | { status: 'REQUIRE_APPROVAL'; handlerEntered: false; strixDecisionId: string; approvalsRequired: number; approvalsGranted: number }
  | { status: 'REFUSE'; handlerEntered: false; refusedBy: 'strix' | 'local'; reasonCode: string; detail: string; strixDecisionId: string | null; mismatchedFields?: string[]; refusalEvidenceId?: string }
  | { status: 'UNAVAILABLE'; handlerEntered: false; code: string; detail: string };

export interface ExecuteGovernedInput<T> {
  client: StrixExecutionAuthorityClient;
  proposal: ProposedExecution;
  /** Who presents the grant (recorded by Strix as consumedBy / reportedBy). */
  presenter: string;
  minimumApprovals?: number;
  /**
   * A grant already obtained for this proposal (after an APPROVAL_REQUIRED
   * round-trip). When absent, the adapter evaluates first.
   */
  grant?: SignedGrant;
  /**
   * The execution as it stands immediately before the handler runs. Defaults
   * to the proposal's own commitments; a consumer that re-reads payload and
   * standing at the boundary supplies them here.
   */
  currentExecution?: () => CurrentExecution | Promise<CurrentExecution>;
  /** The consequential code. Entered only on PERMIT. */
  handler: (execution: CurrentExecution, grant: GrantPayload) => Promise<T>;
  /** What the handler observed, for the outcome report. Optional. */
  observedConsequence?: (result: T) => Record<string, unknown> | null;
}

export async function executeGoverned<T>(input: ExecuteGovernedInput<T>): Promise<GovernedOutcome<T>> {
  const { client, proposal, presenter, handler } = input;

  let grant = input.grant;
  if (!grant) {
    let ev: EvaluateResult;
    try {
      ev = await client.evaluate(proposal, { minimumApprovals: input.minimumApprovals });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { status: 'UNAVAILABLE', handlerEntered: false, code: e.code ?? 'EVALUATE_FAILED', detail: e.message ?? String(err) };
    }
    if (ev.status === 'APPROVAL_REQUIRED') {
      return { status: 'REQUIRE_APPROVAL', handlerEntered: false, strixDecisionId: ev.strixDecisionId, approvalsRequired: ev.approvalsRequired, approvalsGranted: ev.approvalsGranted };
    }
    if (ev.status === 'REFUSED') {
      return { status: 'REFUSE', handlerEntered: false, refusedBy: 'strix', reasonCode: ev.reasonCode, detail: 'Strix refused the proposal', strixDecisionId: ev.strixDecisionId };
    }
    grant = ev.grant;
  }

  const execution = input.currentExecution ? await input.currentExecution() : currentExecutionOf(proposal);
  const redeemed: RedeemResult = await client.redeem(grant, execution, presenter);

  if (redeemed.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', handlerEntered: false, code: redeemed.code, detail: redeemed.detail };
  if (redeemed.status === 'REFUSE') {
    return {
      status: 'REFUSE',
      handlerEntered: false,
      refusedBy: redeemed.refusedBy,
      reasonCode: redeemed.reasonCode,
      detail: redeemed.detail,
      strixDecisionId: grant.payload?.strixDecisionId ?? null,
      mismatchedFields: redeemed.mismatchedFields,
      ...(redeemed.refusalEvidenceId ? { refusalEvidenceId: redeemed.refusalEvidenceId } : {}),
    };
  }

  // PERMIT: the ONLY place the handler is entered.
  const grantId = redeemed.grantId;
  let result: T;
  try {
    result = await handler(execution, grant.payload);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const outcome = await report(client, grantId, { outcome: 'FAILED', handlerEntered: true, reportedBy: presenter, detail: error.slice(0, 500) });
    return { status: 'PERMIT_HANDLER_FAILED', handlerEntered: true, grant: grant.payload, strixDecisionId: redeemed.strixDecisionId, error, outcome };
  }
  const observed = input.observedConsequence ? input.observedConsequence(result) : null;
  const outcome = await report(client, grantId, { outcome: 'EXECUTED', handlerEntered: true, observedConsequence: observed, reportedBy: presenter });
  return { status: 'PERMIT', handlerEntered: true, grant: grant.payload, strixDecisionId: redeemed.strixDecisionId, result, outcome };
}

async function report(client: StrixExecutionAuthorityClient, grantId: string, r: Parameters<StrixExecutionAuthorityClient['reportOutcome']>[1]) {
  try {
    return await client.reportOutcome(grantId, r);
  } catch (err) {
    // The consequence already happened; a lost report is reported as lost,
    // never as a recorded outcome.
    return { status: 'UNREPORTED' as const, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The same rule for an agent-platform / MCP-style tool: wrap a tool's
 * `execute` so it runs only under a PERMIT for the exact arguments presented.
 * `proposalFor` maps the tool call to a proposal (the integrator computes the
 * payload and state commitments); the returned tool refuses with a structured
 * error otherwise.
 */
export interface GovernedTool<A, T> {
  name: string;
  execute: (args: A) => Promise<GovernedOutcome<T>>;
}

export function governedTool<A, T>(opts: {
  name: string;
  client: StrixExecutionAuthorityClient;
  presenter: string;
  proposalFor: (args: A) => ProposedExecution | Promise<ProposedExecution>;
  grantFor?: (args: A, proposal: ProposedExecution) => SignedGrant | undefined | Promise<SignedGrant | undefined>;
  minimumApprovals?: number;
  handler: (args: A, execution: CurrentExecution, grant: GrantPayload) => Promise<T>;
}): GovernedTool<A, T> {
  return {
    name: opts.name,
    async execute(args: A) {
      const proposal = await opts.proposalFor(args);
      const grant = opts.grantFor ? await opts.grantFor(args, proposal) : undefined;
      return executeGoverned<T>({
        client: opts.client,
        proposal,
        presenter: opts.presenter,
        minimumApprovals: opts.minimumApprovals,
        grant,
        handler: (execution, g) => opts.handler(args, execution, g),
      });
    },
  };
}
