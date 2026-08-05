#!/usr/bin/env node
/**
 * strix-mcp-credentials CLI
 *
 * Manages upstream MCP server secrets in the OS keychain.
 *
 * Usage:
 *   strix-mcp-credentials set <key>           # store a secret (prompted, no echo)
 *   strix-mcp-credentials get <key>           # print value to stdout
 *   strix-mcp-credentials list                # list all stored keys
 *   strix-mcp-credentials remove <key>        # delete a secret
 */

import readline from "node:readline/promises";
import process from "node:process";
import {
  setCredential,
  getCredential,
  removeCredential,
  listCredentials,
  KeychainUnavailableError,
  KeychainPermissionError,
} from "../src/index.mjs";

const USAGE = `\
Usage: strix-mcp-credentials <command> [key]

Commands:
  set <key>     Store a credential in the OS keychain (value read from stdin)
  get <key>     Print a stored credential to stdout
  list          List all stored credential keys
  remove <key>  Delete a stored credential

Examples:
  strix-mcp-credentials set notion.token
  strix-mcp-credentials list
  strix-mcp-credentials get notion.token
  strix-mcp-credentials remove notion.token

The key name is a logical identifier (e.g. "notion.token", "github.token").
It maps to the keychain account under the "strix-mcp" service.
`;

const [, , cmd, key] = process.argv;

async function main() {
  switch (cmd) {
    case "set":
      return cmdSet(key);
    case "get":
      return cmdGet(key);
    case "list":
      return cmdList();
    case "remove":
    case "delete":
    case "rm":
      return cmdRemove(key);
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case undefined:
    case null:
      process.stderr.write("strix-mcp-credentials: no command given\n\n" + USAGE);
      return 1;
    default:
      process.stderr.write(`strix-mcp-credentials: unknown command '${cmd}'\n\n` + USAGE);
      return 1;
  }
}

async function cmdSet(k) {
  if (!k) {
    process.stderr.write("strix-mcp-credentials set: key argument required\n");
    process.stderr.write("Usage: strix-mcp-credentials set <key>\n");
    return 1;
  }

  let value;
  if (!process.stdin.isTTY) {
    // Non-interactive mode — read value from piped stdin.
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    value = Buffer.concat(chunks).toString("utf-8").trimEnd();
  } else {
    // Interactive TTY — prompt with hidden input (no echo).
    value = await readHidden(`Enter value for '${k}': `);
  }

  if (!value) {
    process.stderr.write("strix-mcp-credentials set: empty value not stored\n");
    return 1;
  }

  try {
    await setCredential(k, value);
    process.stderr.write(`✓ Credential '${k}' stored in keychain.\n`);
    return 0;
  } catch (err) {
    return handleKeychainError(err, `set '${k}'`);
  }
}

async function cmdGet(k) {
  if (!k) {
    process.stderr.write("strix-mcp-credentials get: key argument required\n");
    process.stderr.write("Usage: strix-mcp-credentials get <key>\n");
    return 1;
  }
  try {
    const value = await getCredential(k);
    if (value === null) {
      process.stderr.write(`strix-mcp-credentials get: key '${k}' not found\n`);
      return 1;
    }
    // Value goes to stdout — suitable for shell command substitution.
    process.stdout.write(value);
    if (process.stdout.isTTY) process.stdout.write("\n");
    return 0;
  } catch (err) {
    return handleKeychainError(err, `get '${k}'`);
  }
}

async function cmdList() {
  try {
    const keys = await listCredentials();
    if (keys.length === 0) {
      process.stderr.write("No credentials stored under 'strix-mcp' service.\n");
    } else {
      process.stdout.write(keys.join("\n") + "\n");
    }
    return 0;
  } catch (err) {
    return handleKeychainError(err, "list");
  }
}

async function cmdRemove(k) {
  if (!k) {
    process.stderr.write("strix-mcp-credentials remove: key argument required\n");
    process.stderr.write("Usage: strix-mcp-credentials remove <key>\n");
    return 1;
  }
  try {
    const deleted = await removeCredential(k);
    if (!deleted) {
      process.stderr.write(`strix-mcp-credentials remove: key '${k}' not found\n`);
      return 1;
    }
    process.stderr.write(`✓ Credential '${k}' removed from keychain.\n`);
    return 0;
  } catch (err) {
    return handleKeychainError(err, `remove '${k}'`);
  }
}

/**
 * Read a line from stdin without echoing characters to the terminal.
 * Uses a readline internal API that is stable across Node 18-22.
 *
 * @param {string} prompt - Text written to stderr before reading
 * @returns {Promise<string>}
 */
async function readHidden(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  process.stderr.write(prompt);

  // Suppress character echo by replacing the internal output writer.
  const originalWrite = rl._writeToOutput.bind(rl);
  rl._writeToOutput = () => {};

  try {
    const value = await rl.question("");
    // Restore and emit newline so the terminal looks clean.
    rl._writeToOutput = originalWrite;
    process.stderr.write("\n");
    return value;
  } finally {
    rl._writeToOutput = originalWrite;
    rl.close();
  }
}

function handleKeychainError(err, op) {
  if (err instanceof KeychainUnavailableError) {
    process.stderr.write(
      `strix-mcp-credentials: keychain unavailable (${op})\n` +
        `  ${err.message}\n` +
        `  Tip: install keytar with: npm install -g keytar\n` +
        `  Or set the credential as an environment variable instead.\n`,
    );
    return 2;
  }
  if (err instanceof KeychainPermissionError) {
    process.stderr.write(
      `strix-mcp-credentials: keychain permission denied (${op})\n` +
        `  ${err.message}\n`,
    );
    return 2;
  }
  process.stderr.write(
    `strix-mcp-credentials: error during ${op}: ${err.message}\n`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`strix-mcp-credentials: unexpected error: ${err.message}\n`);
    process.exit(1);
  },
);
