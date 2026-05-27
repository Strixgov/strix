/**
 * Shell adapter — governed process spawning.
 *
 * Every shell invocation is CRITICAL by default. The adapter ALSO
 * enforces a deny-list of patterns commonly used in agent compromise
 * scenarios (rm -rf /, curl | sh, npm publish, etc). Patterns are
 * applied BEFORE policy evaluation so a malformed-but-allowed rule
 * can't accidentally green-light them.
 *
 * Important: the deny-list is a defense-in-depth check, not the
 * authority. The Gateway's PolicyEngine remains the source of truth
 * for whether a command runs.
 */

import { spawn } from "node:child_process";

/** @type {Record<string, import("../types.d.ts").ToolCapability>} */
export const shellCapabilities = {
  "shell.exec": {
    id: "shell.exec",
    name: "shell.exec",
    risk: "CRITICAL",
    mode: "EXECUTE",
    description: "Execute a shell command in a child process.",
  },
  "shell.spawn": {
    id: "shell.spawn",
    name: "shell.spawn",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Spawn a process with explicit argv (no shell interpolation).",
  },
};

/**
 * Patterns that cannot ever be ALLOWed, regardless of policy ruleset.
 * If a pattern matches, the gateway issues a DENY receipt instead of
 * even consulting the policy. Add to this list when in doubt — false
 * positives produce a denial; false negatives produce a breach.
 */
export const SHELL_HARDFAIL_PATTERNS = Object.freeze([
  /\brm\s+-rf?\s+\/(\s|$)/, // rm -rf /
  /\brm\s+-rf?\s+~\/?(\s|$)/, // rm -rf ~
  /\brm\s+-rf?\s+\*/, // rm -rf *
  /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)\b/, // curl ... | sh
  /\bwget\s+[^|]*\|\s*(sh|bash|zsh)\b/, // wget ... | sh
  /\b(sudo|doas)\s+rm\b/, // sudo rm
  /\bnpm\s+publish\b/, // npm publish
  /\byarn\s+publish\b/, // yarn publish
  /\bpnpm\s+publish\b/, // pnpm publish
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|hd)/, // dd to a raw block device
  /\bmkfs(\.\w+)?\s/, // mkfs
  /\b(\/etc\/(passwd|shadow|sudoers))\b/, // touching credential files
]);

function matchesHardfail(commandOrArgv) {
  const text = Array.isArray(commandOrArgv)
    ? commandOrArgv.join(" ")
    : String(commandOrArgv ?? "");
  for (const re of SHELL_HARDFAIL_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return null;
}

/**
 * @param {import("../gateway.mjs").Gateway} gateway
 * @param {{ actorId?: string, actorRole?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [ctx]
 */
export function governedShell(gateway, ctx = {}) {
  for (const cap of Object.values(shellCapabilities)) {
    gateway.registerCapability(cap);
  }

  /**
   * Run a string command via /bin/sh. Subject to SHELL_HARDFAIL_PATTERNS.
   *
   * @param {string} command
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function exec(command, opts = {}) {
    const hardfail = matchesHardfail(command);
    if (hardfail) {
      // Hardfail bypasses the policy engine entirely — even if the
      // ruleset says ALLOW, this command does not run. The adapter
      // is the authority here, not the policy.
      const receipt = await gateway.recordDenial({
        invocation: {
          capabilityId: "shell.exec",
          action: "shell.exec",
          args: { command, hardfailPattern: hardfail },
          actorId: ctx.actorId,
          actorRole: ctx.actorRole,
        },
        capability: shellCapabilities["shell.exec"],
        reason: `HARDFAIL_PATTERN:${hardfail}`,
      });
      const err = new Error(
        `shell.exec denied (hard-fail pattern: ${hardfail})`
      );
      // @ts-expect-error attaching context
      err.code = "HARDFAIL_PATTERN";
      // @ts-expect-error
      err.receipt = receipt;
      throw err;
    }

    const result = await gateway.execute(
      {
        capabilityId: "shell.exec",
        action: "shell.exec",
        args: { command },
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
      },
      () => runChild(["/bin/sh", "-c", command], ctx, opts.timeoutMs)
    );
    if (!result.ok) {
      const err = new Error(
        `shell.exec denied: ${result.error?.message ?? "policy denied"}`
      );
      // @ts-expect-error
      err.code = result.error?.code ?? "DENIED";
      // @ts-expect-error
      err.receipt = result.receipt;
      throw err;
    }
    return result.result;
  }

  /**
   * Spawn argv directly (no shell interpolation). Still subject to
   * SHELL_HARDFAIL_PATTERNS evaluated against the joined argv.
   *
   * @param {string} cmd
   * @param {string[]} argv
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function exec_argv(cmd, argv = [], opts = {}) {
    const full = [cmd, ...argv];
    const hardfail = matchesHardfail(full);
    if (hardfail) {
      const receipt = await gateway.recordDenial({
        invocation: {
          capabilityId: "shell.spawn",
          action: "shell.spawn",
          args: { cmd, argv, hardfailPattern: hardfail },
          actorId: ctx.actorId,
          actorRole: ctx.actorRole,
        },
        capability: shellCapabilities["shell.spawn"],
        reason: `HARDFAIL_PATTERN:${hardfail}`,
      });
      const err = new Error(
        `shell.spawn denied (hard-fail pattern: ${hardfail})`
      );
      // @ts-expect-error attaching context
      err.code = "HARDFAIL_PATTERN";
      // @ts-expect-error
      err.receipt = receipt;
      throw err;
    }

    const result = await gateway.execute(
      {
        capabilityId: "shell.spawn",
        action: "shell.spawn",
        args: { cmd, argv },
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
      },
      () => runChild([cmd, ...argv], ctx, opts.timeoutMs)
    );
    if (!result.ok) {
      const err = new Error(
        `shell.spawn denied: ${result.error?.message ?? "policy denied"}`
      );
      // @ts-expect-error
      err.code = result.error?.code ?? "DENIED";
      // @ts-expect-error
      err.receipt = result.receipt;
      throw err;
    }
    return result.result;
  }

  return { exec, exec_argv };
}

function runChild(argv, ctx, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, {
      cwd: ctx.cwd,
      env: ctx.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`shell child timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
