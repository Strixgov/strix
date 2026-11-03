export declare const PROMPT_HOOK_MODES: readonly ['block', 'warn'];
export declare const PROMPT_HOOK_CEILING: 'NO_FINDINGS_BY_DETECTOR';
export declare const PROMPT_HOOK_MARKER: 'strix-egress-prompt-hook';
export declare function resolveHookMode(env?: Record<string, string | undefined>): {
  mode: 'block' | 'warn';
  recognised: boolean;
};
export declare function summarizeFindings(findings: ReadonlyArray<{ category: string }>): Record<string, number>;
/** Never throws. exitCode 2 blocks the prompt; 0 lets it through. */
export declare function evaluatePromptHookInput(
  stdinText: string,
  env?: Record<string, string | undefined>,
): { exitCode: 0 | 2; stdout: string; stderr: string };
export declare function installHookIntoSettings(
  settings: Record<string, unknown> | undefined,
  command: string,
): Record<string, unknown>;
