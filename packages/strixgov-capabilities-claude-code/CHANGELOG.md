# Changelog

All notable changes to `@strixgov/capabilities-claude-code` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

### Added
- Initial release.
- Pre-classified capability registry for 16 of Claude Code's built-in tools:
  - **READ-class (LOW)**: `claude.read`, `claude.glob`, `claude.grep`,
    `claude.web_search`, `claude.tool_search`, `claude.monitor`.
  - **WRITE-class (MEDIUM)**: `claude.write`, `claude.edit`,
    `claude.notebook_edit`, `claude.todo_write`.
  - **EXECUTE-class (MEDIUM)**: `claude.task`, `claude.web_fetch`,
    `claude.skill`, `claude.exit_plan_mode`, `claude.ask_user_question`.
  - **EXECUTE-class (HIGH)**: `claude.bash` (consider CRITICAL on
    production hosts).
- `claudeCodeCapabilities` — flat array of capability objects.
- `claudeCodeCapabilityMap()` — `id → capability` map for use as the
  `capabilities` argument to `createGateway`.
- `suggestedPolicy()` — strict baseline policy (reads ALLOW, writes/Bash
  APPROVAL_REQUIRED, `default: DENY`). Intended to be overridden
  per-environment before shipping.

### Notes
- Optional peer dep on `@strixgov/tool-gateway` (`workspace:*` → published
  as `0.4.0` exact). The companion pack works standalone (the maps and
  arrays are pure data), but the gateway is required to actually enforce
  the policy.
- Risk classifications are deliberately conservative starters. Override
  per environment — `bash` HIGH may be CRITICAL on prod, `web_fetch`
  MEDIUM may be HIGH if egress is sensitive.
