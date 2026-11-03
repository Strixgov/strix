# Govern YouSpot with the Strix MCP proxy

This example uses YouSpot's official stdio bridge as the upstream server:

`MCP host -> @strixgov/mcp-proxy -> @youspot/mcp -> https://youspot.com/mcp/v1`

No YouSpot tool implementation is changed.

## 1. Provide the YouSpot token to the host environment

```bash
export YOUSPOT_TOKEN="..."
```

`@youspot/mcp` requires the token for `tools/call`. The example config intentionally does not store it; the proxy passes the process environment through to the upstream when `upstream.env` is omitted.

## 2. Point the MCP host at Strix

```json
{
  "mcpServers": {
    "youspot-governed": {
      "command": "npx",
      "args": [
        "-y",
        "@strixgov/mcp-proxy",
        "--config",
        "/absolute/path/to/youspot-proxy-config.json"
      ]
    }
  }
}
```

The same shape works in stdio-capable hosts that accept command/args MCP definitions. Use the host's normal secure environment mechanism for `YOUSPOT_TOKEN`.

## 3. What the starter policy does

- reviewed read tools -> explicit ALLOW rules
- every other LOW/MEDIUM/HIGH tool -> APPROVAL_REQUIRED
- CRITICAL -> DENY
- policy default -> DENY

The explicit rules are intentional. `@strixgov/mcp-proxy` documents name heuristics as a discovery fallback, not a production security boundary. A YouSpot tool added after this example was reviewed therefore does not inherit an automatic LOW/ALLOW path.
- bundled approval channel -> disabled

With approval disabled, any call that evaluates to `APPROVAL_REQUIRED` is refused rather than auto-approved. Configure a separate approver only when the response channel is not writable by the acting agent.

## 4. Verify

```bash
npx @strixgov/verifier chain ~/.strix-mcp-proxy/youspot/receipts.jsonl \
  --jwks ~/.strix-mcp-proxy/youspot/keys/public-jwk.json
```

## Coverage boundary

Only traffic routed through this local proxy is governed. Direct `https://youspot.com/mcp/v1` connections remain outside this example. Remote-HTTP-only clients require a hosted Strix gateway.
