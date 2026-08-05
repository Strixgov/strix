import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "strix-nooa-secure-coding-demo", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: "inspect_repository",
    description: "Inspect repository metadata without modifying the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        ref: { type: "string", default: "HEAD" },
      },
      required: ["repository"],
    },
  },
  {
    name: "propose_patch",
    description: "Create a patch proposal on a remediation branch without merging it.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        finding: { type: "string" },
      },
      required: ["repository", "finding"],
    },
  },
  {
    name: "merge_production",
    description: "Merge an approved commit to the production branch.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        commit: { type: "string" },
      },
      required: ["repository", "commit"],
    },
  },
  {
    name: "rotate_credentials",
    description: "Rotate a production credential.",
    inputSchema: {
      type: "object",
      properties: {
        credential: { type: "string" },
      },
      required: ["credential"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  switch (name) {
    case "inspect_repository":
      return {
        content: [{ type: "text", text: JSON.stringify({ repository: args.repository, ref: args.ref ?? "HEAD", findings: 1 }) }],
      };
    case "propose_patch":
      return {
        content: [{ type: "text", text: JSON.stringify({ branch: "remediation/nooa-demo", patchProposed: true }) }],
      };
    case "merge_production":
      return {
        content: [{ type: "text", text: JSON.stringify({ merged: true, commit: args.commit }) }],
      };
    case "rotate_credentials":
      return {
        content: [{ type: "text", text: JSON.stringify({ rotated: true, credential: args.credential }) }],
      };
    default:
      throw new Error(`Unknown tool '${name}'`);
  }
});

await server.connect(new StdioServerTransport());
