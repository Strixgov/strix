/**
 * Linear MCP server — capability classifications.
 *
 * Linear's MCP surface varies by deployment; we ship the classifications
 * for the canonical operations. Operators with extended Linear MCP
 * surfaces (workflow state changes, automation triggers) should classify
 * those locally.
 */
export const linearCapabilities = Object.freeze([
  {
    id: "mcp.linear.list_issues",
    name: "list_issues",
    risk: "LOW",
    mode: "READ",
    description: "List Linear issues.",
  },
  {
    id: "mcp.linear.get_issue",
    name: "get_issue",
    risk: "LOW",
    mode: "READ",
    description: "Read a Linear issue.",
  },
  {
    id: "mcp.linear.search_issues",
    name: "search_issues",
    risk: "LOW",
    mode: "READ",
    description: "Search Linear issues.",
  },
  {
    id: "mcp.linear.list_projects",
    name: "list_projects",
    risk: "LOW",
    mode: "READ",
    description: "List Linear projects.",
  },
  {
    id: "mcp.linear.get_project",
    name: "get_project",
    risk: "LOW",
    mode: "READ",
    description: "Read a Linear project.",
  },
  {
    id: "mcp.linear.list_teams",
    name: "list_teams",
    risk: "LOW",
    mode: "READ",
    description: "List Linear teams.",
  },
  {
    id: "mcp.linear.create_issue",
    name: "create_issue",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a Linear issue.",
  },
  {
    id: "mcp.linear.update_issue",
    name: "update_issue",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update a Linear issue (state, assignee, fields).",
  },
  {
    id: "mcp.linear.create_comment",
    name: "create_comment",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Comment on a Linear issue.",
  },
  {
    id: "mcp.linear.delete_issue",
    name: "delete_issue",
    risk: "HIGH",
    mode: "EXECUTE",
    description: "Delete a Linear issue.",
  },
]);
