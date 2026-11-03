# Strix YouSpot Control

Govern the YouSpot MCP connection without changing YouSpot.

This plugin routes YouSpot's official local MCP bridge (`@youspot/mcp`) through the published Strix MCP proxy (`@strixgov/mcp-proxy`). Every routed `callTool` is evaluated before forwarding and produces a signed decision receipt.

## Install

```text
/plugin marketplace add Strixgov/strix
/plugin install strix-youspot-control@strixgov
```

Set `YOUSPOT_TOKEN` in the environment that launches your MCP host, then restart the host. The token is inherited by the upstream YouSpot bridge; it is not stored in this plugin or its policy file.


## Programs run on your machine

Starting this plugin invokes `npx -y @strixgov/mcp-proxy`, which in turn
invokes `npx -y @youspot/mcp`. The latter is third-party YouSpot software,
not Strix code. `-y` accepts npx's install prompt; packages may be downloaded
and executed locally. Both package selectors are unpinned, so the resolved
version can change between installations. Review both packages and pin
reviewed versions in your local plugin/configuration before a controlled
rollout. Matching registry metadata is not a code or supply-chain audit.

The upstream bridge inherits the launching environment, including the
`YOUSPOT_TOKEN` you configure. Use a dedicated, minimally scoped credential.
The wrapper governs routed tool calls; it does not sandbox the upstream
process or prevent it from using credentials directly.

## Safe default

The bundled policy is deliberately fail-closed:

- A frozen set of reviewed read tools is explicitly ALLOW-listed.
- Every other LOW/MEDIUM/HIGH tool — including a newly added YouSpot tool not yet in the census — requires approval.
- CRITICAL tools are denied.
- The policy default is DENY. This means an uncatalogued tool cannot become frictionless merely because its name looks read-only.
- The bundled approval setting is `enabled: false`, so an `APPROVAL_REQUIRED` call cannot silently approve itself; it is refused until you configure a separate approval channel.
- No `autoApprove` mode is bundled.

For meaningful human approval, use a response channel the acting agent cannot write to. Do not point file-based approval responses at a directory available to the same shell-capable agent and call that separation of duties.

## Verify receipts

Receipts and the signing key persist under `~/.strix-mcp-proxy/youspot` by default.

```bash
npx @strixgov/verifier chain ~/.strix-mcp-proxy/youspot/receipts.jsonl \
  --jwks ~/.strix-mcp-proxy/youspot/keys/public-jwk.json
```

## Claim boundary

This plugin governs only YouSpot MCP calls routed through the Strix wrapper. It does not prevent an agent or user from creating a separate direct HTTPS connection to YouSpot. Strong anti-bypass enforcement requires exclusive credential/network custody or a downstream authority validator.

This is not a claim that YouSpot is insecure. YouSpot remains the CRM and MCP provider; Strix adds a separate execution-control boundary.

## Compatibility

This plugin shape is for local stdio-capable MCP hosts. Remote-HTTP-only hosts need a hosted Strix MCP gateway; the local plugin must not be represented as covering them.

## Licenses

The plugin shell is MIT. It invokes `@strixgov/mcp-proxy` (Elastic-2.0) and `@youspot/mcp` (MIT); their own licenses control those packages.
