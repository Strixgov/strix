# Three questions for your prior-auth agent

*(The lead-in for the proof kit. Send this first; the clips answer it.)*

You've got strong policy and guardrails. So rather than pitch anything, here
are three questions to put to your own system. They map to failures happening
across RCM agent deployments right now — and each one is filmed, governed vs.
ungoverned, in the clips that follow.

1. **If your agent produces a correct plan but then submits to the wrong payer —
   or the wrong patient in a batch — what stops the submit from going out?**
   (Not what *logs* it. What *stops* it.)

2. **If an approved auth or claim is retried, can it execute twice?**
   (Duplicate 278s/837s are a leading source of denials and recoupment.)

3. **If you revoke an approval while the agent is mid-task, does the in-flight
   action still fire?**

For most stacks — even the best ones — the honest answer to all three is
*"we'd catch it after, in logs or at the denial."* That's a detective control:
it tells you what went wrong; it doesn't prevent the wrong action.

The attached clips show the difference on a real RCM stack (real X12 278,
synthetic patients, a payer endpoint we control). Same agent, same task, run
twice: once with policy + guardrails only, once governed by Strix at the
execution boundary. Watch where the wrong action fires — and where it doesn't.
