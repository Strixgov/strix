from pathlib import Path

try:
    from nooa.mcp import MCPManager
except ImportError as exc:
    raise ImportError(
        "NVIDIA OO Agents MCP support is required. In the NOOA repository run: uv sync --extra mcp"
    ) from exc

from nooa.util.quickstart import Agent, autorun, llm


MCP_CONFIG = Path(__file__).with_name(".mcp.json")


class GovernedRemediationAgent(Agent, llm=llm):
    """Inspect a repository and propose remediation without bypassing Strix governance.

    Use the Strix-governed MCP tools. Repository inspection and patch proposal are
    permitted by the demo policy. Production merge requires a separate approval.
    Credential rotation is prohibited.
    """

    secure_coding = MCPManager.create_from_server(
        "strix_secure_coding",
        mcp_file=MCP_CONFIG,
    )

    async def remediate(self, repository: str, finding: str) -> str:
        """Inspect the repository, propose a patch for the finding, and report the result.

        Do not attempt production merge or credential rotation unless the user
        explicitly requests it; Strix will independently evaluate every tool call.
        """
        ...


@autorun
async def main() -> None:
    agent = GovernedRemediationAgent()
    result = await agent.remediate(
        "demo/repo",
        "Dependency input is accepted without validation",
    )
    print(result)
