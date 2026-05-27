/**
 * GitHub MCP server — capability classifications.
 *
 * Risk model:
 *   - All `list`/`get`/`search`/`*_read` ops are LOW READ.
 *   - Comments, branches, file edits, and PR drafts are MEDIUM WRITE.
 *   - Pushing files, creating PRs, force-merging, deleting files, and
 *     enabling auto-merge are HIGH (touches default branch / others' work).
 *   - `merge_pull_request` is CRITICAL EXECUTE — irreversible from the
 *     governance gate's perspective (a merged PR cannot be un-merged
 *     atomically; revert is a *new* commit).
 *   - Repo creation is HIGH WRITE — visible publicly, hard to undo.
 *   - Webhook manipulation, secret scanning toggles, and workflow
 *     dispatch (when present) should be classified CRITICAL by the
 *     consumer. We don't ship those classifications because the MCP
 *     server's exposed set varies.
 */
export const githubCapabilities = Object.freeze([
  // ── Reads ────────────────────────────────────────────────────────────
  {
    id: "mcp.github.list_issues",
    name: "list_issues",
    risk: "LOW",
    mode: "READ",
    description: "List issues in a repository.",
  },
  {
    id: "mcp.github.issue_read",
    name: "issue_read",
    risk: "LOW",
    mode: "READ",
    description: "Read a specific issue.",
  },
  {
    id: "mcp.github.list_pull_requests",
    name: "list_pull_requests",
    risk: "LOW",
    mode: "READ",
    description: "List pull requests.",
  },
  {
    id: "mcp.github.pull_request_read",
    name: "pull_request_read",
    risk: "LOW",
    mode: "READ",
    description: "Read a pull request including comments and reviews.",
  },
  {
    id: "mcp.github.list_branches",
    name: "list_branches",
    risk: "LOW",
    mode: "READ",
    description: "List branches.",
  },
  {
    id: "mcp.github.list_commits",
    name: "list_commits",
    risk: "LOW",
    mode: "READ",
    description: "List commits.",
  },
  {
    id: "mcp.github.get_commit",
    name: "get_commit",
    risk: "LOW",
    mode: "READ",
    description: "Read a specific commit.",
  },
  {
    id: "mcp.github.get_file_contents",
    name: "get_file_contents",
    risk: "LOW",
    mode: "READ",
    description: "Read a file at a ref.",
  },
  {
    id: "mcp.github.search_code",
    name: "search_code",
    risk: "LOW",
    mode: "READ",
    description: "Search code.",
  },
  {
    id: "mcp.github.search_issues",
    name: "search_issues",
    risk: "LOW",
    mode: "READ",
    description: "Search issues.",
  },
  {
    id: "mcp.github.search_pull_requests",
    name: "search_pull_requests",
    risk: "LOW",
    mode: "READ",
    description: "Search pull requests.",
  },
  {
    id: "mcp.github.search_repositories",
    name: "search_repositories",
    risk: "LOW",
    mode: "READ",
    description: "Search repositories.",
  },
  {
    id: "mcp.github.search_users",
    name: "search_users",
    risk: "LOW",
    mode: "READ",
    description: "Search users.",
  },
  {
    id: "mcp.github.run_secret_scanning",
    name: "run_secret_scanning",
    risk: "LOW",
    mode: "READ",
    description: "Run a secret-scanning report.",
  },
  // ── Writes (medium) ──────────────────────────────────────────────────
  {
    id: "mcp.github.add_issue_comment",
    name: "add_issue_comment",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Comment on an issue. Visible to others.",
  },
  {
    id: "mcp.github.add_comment_to_pending_review",
    name: "add_comment_to_pending_review",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Add a comment to a pending pull-request review.",
  },
  {
    id: "mcp.github.add_reply_to_pull_request_comment",
    name: "add_reply_to_pull_request_comment",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Reply to a pull-request comment.",
  },
  {
    id: "mcp.github.create_branch",
    name: "create_branch",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a branch from a ref.",
  },
  {
    id: "mcp.github.create_or_update_file",
    name: "create_or_update_file",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create or update a single file via the contents API.",
  },
  {
    id: "mcp.github.update_pull_request",
    name: "update_pull_request",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update PR title/body/state.",
  },
  {
    id: "mcp.github.update_pull_request_branch",
    name: "update_pull_request_branch",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update PR head branch from base.",
  },
  {
    id: "mcp.github.pull_request_review_write",
    name: "pull_request_review_write",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Submit a pull-request review.",
  },
  {
    id: "mcp.github.request_copilot_review",
    name: "request_copilot_review",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Request a Copilot review on a PR.",
  },
  {
    id: "mcp.github.resolve_review_thread",
    name: "resolve_review_thread",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Resolve a review thread.",
  },
  {
    id: "mcp.github.unresolve_review_thread",
    name: "unresolve_review_thread",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Reopen a previously-resolved review thread.",
  },
  {
    id: "mcp.github.fork_repository",
    name: "fork_repository",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Fork a repository.",
  },
  {
    id: "mcp.github.disable_pr_auto_merge",
    name: "disable_pr_auto_merge",
    risk: "MEDIUM",
    mode: "EXECUTE",
    description: "Disable auto-merge on a pull request.",
  },
  // ── Writes (high) ────────────────────────────────────────────────────
  {
    id: "mcp.github.create_pull_request",
    name: "create_pull_request",
    risk: "HIGH",
    mode: "WRITE",
    description: "Open a pull request. Visible to others.",
  },
  {
    id: "mcp.github.push_files",
    name: "push_files",
    risk: "HIGH",
    mode: "WRITE",
    description: "Push files in a single commit. Touches branch tip.",
  },
  {
    id: "mcp.github.create_repository",
    name: "create_repository",
    risk: "HIGH",
    mode: "WRITE",
    description: "Create a repository.",
  },
  {
    id: "mcp.github.delete_file",
    name: "delete_file",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Delete a file via the contents API.",
  },
  {
    id: "mcp.github.enable_pr_auto_merge",
    name: "enable_pr_auto_merge",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Enable auto-merge — PR will land without further review.",
  },
  // ── Critical ─────────────────────────────────────────────────────────
  {
    id: "mcp.github.merge_pull_request",
    name: "merge_pull_request",
    risk: "CRITICAL",
    mode: "EXECUTE",
    description:
      "Merge a pull request. Effectively irreversible — revert is a new commit, not undo.",
  },
]);
