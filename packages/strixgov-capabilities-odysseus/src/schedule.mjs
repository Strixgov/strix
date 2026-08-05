/**
 * Odysseus host surface — scheduled tasks.
 *
 * Risk model:
 *   - Creating a schedule is HIGH WRITE: it projects agent authority
 *     forward in time — a future autonomous execution is being armed.
 *   - Executing a scheduled task is HIGH EXECUTE and MUST be
 *     re-evaluated at fire time. Approval at creation does not
 *     transfer to execution (Strix core invariant 2: execution does
 *     not inherit authority). The fire-time evaluation carries the
 *     risk tier of whatever the task actually does.
 *   - Deleting a schedule is MEDIUM WRITE (reversible by re-creating).
 *
 * Interception: `host-hook` — Odysseus's scheduler is a native path.
 */
export const scheduleCapabilities = Object.freeze([
  {
    id: "odysseus.schedule.create",
    name: "schedule.create",
    risk: "HIGH",
    mode: "WRITE",
    interception: "host-hook",
    description:
      "Create a scheduled task. Arms a future autonomous execution; authority is re-evaluated at fire time.",
  },
  {
    id: "odysseus.schedule.delete",
    name: "schedule.delete",
    risk: "MEDIUM",
    mode: "WRITE",
    interception: "host-hook",
    description: "Delete a scheduled task. Reversible by re-creating it.",
  },
  {
    id: "odysseus.schedule.execute",
    name: "schedule.execute",
    risk: "HIGH",
    mode: "EXECUTE",
    interception: "host-hook",
    description:
      "A scheduled task fires. Re-evaluated at execution time; approval at creation does not transfer.",
  },
]);
