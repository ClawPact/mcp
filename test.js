import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      AGENT_PK: process.env.AGENT_PK || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // Dummy
      AGENTPACT_JWT_TOKEN: process.env.AGENTPACT_JWT_TOKEN || "test",
    }
  });

  const client = new Client({
    name: "test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  
  console.log("Connected. Getting available tools...");
  const tools = await client.listTools();
  console.log("Found " + tools.tools.length + " tools.");

  console.log("\\nTesting agentpact_send_message with a non-existent file...");
  try {
    const result = await client.callTool({
      name: "agentpact_send_message",
      arguments: {
        taskId: "test-task",
        filePath: "not-found.md"
      }
    });
    console.log("Result:", result);
  } catch (error) {
    console.error("Caught expected error:", error);
  }

  process.exit(0);
}

main().catch(console.error);
