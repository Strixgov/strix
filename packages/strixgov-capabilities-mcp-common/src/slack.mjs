/**
 * Slack MCP server — capability classifications.
 *
 * Risk model:
 *   - All `read`/`search` ops are LOW READ. Slack data is sensitive but
 *     reading it does not change state.
 *   - Outbound messages and canvases are MEDIUM WRITE — visible to
 *     other people. Drafts are LOW because they don't notify anyone.
 *   - No CRITICAL Slack capability today: there is no built-in
 *     destroy-channel / archive-workspace primitive in the MCP surface.
 *     If a wrapper exposes one, classify CRITICAL EXECUTE locally.
 */
export const slackCapabilities = Object.freeze([
  {
    id: "mcp.slack.send_message",
    name: "slack_send_message",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Post a message to a channel or DM. Visible to others.",
  },
  {
    id: "mcp.slack.send_message_draft",
    name: "slack_send_message_draft",
    risk: "LOW",
    mode: "WRITE",
    description: "Save a draft message. Not visible to recipients.",
  },
  {
    id: "mcp.slack.schedule_message",
    name: "slack_schedule_message",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Schedule a message for future delivery.",
  },
  {
    id: "mcp.slack.create_canvas",
    name: "slack_create_canvas",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Create a Slack canvas.",
  },
  {
    id: "mcp.slack.update_canvas",
    name: "slack_update_canvas",
    risk: "MEDIUM",
    mode: "WRITE",
    description: "Update an existing Slack canvas.",
  },
  {
    id: "mcp.slack.read_canvas",
    name: "slack_read_canvas",
    risk: "LOW",
    mode: "READ",
    description: "Read a canvas's contents.",
  },
  {
    id: "mcp.slack.read_channel",
    name: "slack_read_channel",
    risk: "LOW",
    mode: "READ",
    description: "Read messages in a channel.",
  },
  {
    id: "mcp.slack.read_thread",
    name: "slack_read_thread",
    risk: "LOW",
    mode: "READ",
    description: "Read replies in a thread.",
  },
  {
    id: "mcp.slack.read_user_profile",
    name: "slack_read_user_profile",
    risk: "LOW",
    mode: "READ",
    description: "Read a user's profile.",
  },
  {
    id: "mcp.slack.search_channels",
    name: "slack_search_channels",
    risk: "LOW",
    mode: "READ",
    description: "Search for channels by name or topic.",
  },
  {
    id: "mcp.slack.search_public",
    name: "slack_search_public",
    risk: "LOW",
    mode: "READ",
    description: "Search messages in public channels.",
  },
  {
    id: "mcp.slack.search_public_and_private",
    name: "slack_search_public_and_private",
    risk: "LOW",
    mode: "READ",
    description:
      "Search messages across public and private channels the user has access to.",
  },
  {
    id: "mcp.slack.search_users",
    name: "slack_search_users",
    risk: "LOW",
    mode: "READ",
    description: "Search users by name or email.",
  },
]);
