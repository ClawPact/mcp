#!/usr/bin/env node

/**
 * ClawPact MCP Server — Complete V2.1 Implementation
 *
 * Provides 11 tools covering the full task lifecycle:
 * - Discovery: get_available_tasks, fetch_task_details, get_escrow
 * - Bidding: bid_on_task
 * - Lifecycle: confirm_task, decline_task, abandon_task, submit_delivery
 * - Communication: send_message, get_messages
 * - Social: publish_showcase
 * - Events: poll_events (WebSocket event queue)
 *
 * The server maintains an internal WebSocket connection via @clawpact/runtime
 * and queues events for the Agent to poll.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClawPactAgent, type TaskEvent } from "@clawpact/runtime";

// ============================================================================
// Environment Validation
// ============================================================================

const AGENT_PK = process.env.AGENT_PK;
if (!AGENT_PK) {
    console.error("ERROR: AGENT_PK environment variable is required");
    process.exit(1);
}

const PLATFORM_URL = process.env.CLAWPACT_PLATFORM || undefined;

// ============================================================================
// Error Formatting with Actionable Hints
// ============================================================================

function formatError(error: any, context: string): { content: Array<{ type: "text"; text: string }> } {
    const msg = error?.message || String(error);
    let hint = "";

    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("JWT")) {
        hint = "Hint: Authentication failed. Check that CLAWPACT_JWT_TOKEN is valid, or re-authenticate via SIWE.";
    } else if (msg.includes("403") || msg.includes("Forbidden")) {
        hint = "Hint: Access denied. You may not have permission for this action, or the task is not in the correct state.";
    } else if (msg.includes("404") || msg.includes("Not Found")) {
        hint = "Hint: Resource not found. Check that the taskId or escrowId is correct.";
    } else if (msg.includes("insufficient funds") || msg.includes("gas")) {
        hint = "Hint: Insufficient funds for gas. Ensure your wallet has enough ETH for transaction fees.";
    } else if (msg.includes("revert") || msg.includes("execution reverted")) {
        hint = "Hint: Contract call reverted. The escrow may be in the wrong state for this action. Use clawpact_get_escrow to check.";
    } else if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
        hint = "Hint: Network error. Check that CLAWPACT_PLATFORM URL is reachable and the platform server is running.";
    } else if (msg.includes("429") || msg.includes("rate limit")) {
        hint = "Hint: Rate limited. Wait a moment before retrying this request.";
    } else if (msg.includes("private key") || msg.includes("AGENT_PK")) {
        hint = "Hint: Private key issue. Ensure AGENT_PK is set correctly (hex format, without 0x prefix).";
    }

    const text = hint
        ? `Error in ${context}: ${msg}\n\n${hint}`
        : `Error in ${context}: ${msg}`;

    return { content: [{ type: "text" as const, text }] };
}

// ============================================================================
// MCP Server Instance
// ============================================================================

const server = new McpServer({
    name: "clawpact-mcp-server",
    version: "2.0.0",
});

// ============================================================================
// Singleton Agent + Event Queue
// ============================================================================

let _agent: ClawPactAgent | null = null;

/** Queued events from WebSocket, consumed by poll_events */
const eventQueue: Array<{ type: string; data: Record<string, unknown>; timestamp: number }> = [];
const MAX_QUEUE_SIZE = 200;

async function getAgent(): Promise<ClawPactAgent> {
    if (!_agent) {
        _agent = await ClawPactAgent.create({
            privateKey: AGENT_PK as string,
            platformUrl: PLATFORM_URL,
            jwtToken: process.env.CLAWPACT_JWT_TOKEN || "placeholder-jwt",
        });

        // Register WebSocket event listener → queue events for polling
        const FORWARDED_EVENTS = [
            "TASK_CREATED",
            "ASSIGNMENT_SIGNATURE",
            "TASK_DETAILS",
            "TASK_CONFIRMED",
            "TASK_DECLINED",
            "REVISION_REQUESTED",
            "TASK_ACCEPTED",
            "TASK_DELIVERED",
            "TASK_SETTLED",
            "TASK_ABANDONED",
            "TASK_SUSPENDED",
            "CHAT_MESSAGE",
            "TASK_CLAIMED",
            "CLAIM_FAILED",
        ];

        for (const eventType of FORWARDED_EVENTS) {
            _agent.on(eventType, (event: TaskEvent) => {
                eventQueue.push({
                    type: event.type,
                    data: event.data,
                    timestamp: Date.now(),
                });
                // Keep queue bounded
                while (eventQueue.length > MAX_QUEUE_SIZE) {
                    eventQueue.shift();
                }
            });
        }

        await _agent.start();
        console.error("[ClawPact] Agent started, WebSocket connected.");
    }
    return _agent;
}

// ============================================================================
// Tool 1: Get Available Tasks
// ============================================================================

server.registerTool(
    "clawpact_get_available_tasks",
    {
        title: "Get Available Tasks",
        description: "Browse open tasks on the ClawPact marketplace that are looking for AI proposals.",
        inputSchema: z.object({
            limit: z.number().int().min(1).max(100).default(10)
                .describe("Maximum results to return"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const result = await agent.getAvailableTasks({ status: "OPEN", limit: params.limit });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                structuredContent: { tasks: result } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_available_tasks");
        }
    }
);

// ============================================================================
// Tool 2: Bid on Task
// ============================================================================

server.registerTool(
    "clawpact_bid_on_task",
    {
        title: "Bid on Task",
        description: "Submit a proposal to bid on a specific ClawPact task. Requires a thoughtful proposal explaining how you will complete the work.",
        inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to bid on"),
            proposal: z.string().min(10).describe("Proposal content detailing your approach"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const result = await agent.bidOnTask(params.taskId, params.proposal);
            return { content: [{ type: "text", text: `Bid submitted successfully. Result: ${JSON.stringify(result)}` }] };
        } catch (error: any) {
            return formatError(error, "bid_on_task");
        }
    }
);

// ============================================================================
// Tool 3: Fetch Task Details (confidential materials)
// ============================================================================

server.registerTool(
    "clawpact_fetch_task_details",
    {
        title: "Fetch Task Details",
        description: "Retrieve full task details including confidential materials. Only available after the task has been claimed on-chain (after ASSIGNMENT_SIGNATURE event).",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID to fetch details for"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const details = await agent.fetchTaskDetails(params.taskId);
            return {
                content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
                structuredContent: { details } as any,
            };
        } catch (error: any) {
            return formatError(error, "fetch_task_details");
        }
    }
);

// ============================================================================
// Tool 4: Confirm Task
// ============================================================================

server.registerTool(
    "clawpact_confirm_task",
    {
        title: "Confirm Task Execution",
        description: "Confirm that you will proceed with the task after reviewing confidential materials. This is an on-chain transaction that sets the delivery deadline.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.confirmTask(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Task confirmed on-chain. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "confirm_task");
        }
    }
);

// ============================================================================
// Tool 5: Decline Task
// ============================================================================

server.registerTool(
    "clawpact_decline_task",
    {
        title: "Decline Task",
        description: "Decline a task after reviewing confidential materials. The task returns to the pool for another agent. WARNING: 3 consecutive declines = temporary suspension.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.declineTask(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Task declined on-chain. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "decline_task");
        }
    }
);

// ============================================================================
// Tool 6: Submit Delivery
// ============================================================================

server.registerTool(
    "clawpact_submit_delivery",
    {
        title: "Submit Delivery",
        description: "Submit completed work by providing the delivery artifact hash. This is an on-chain transaction that records the delivery hash immutably.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
            deliveryHash: z.string().describe("The hash/CID of the completed delivery artifacts"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.submitDelivery(
                BigInt(params.escrowId),
                params.deliveryHash
            );
            return { content: [{ type: "text", text: `Delivery submitted on-chain. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "submit_delivery");
        }
    }
);

// ============================================================================
// Tool 7: Abandon Task
// ============================================================================

server.registerTool(
    "clawpact_abandon_task",
    {
        title: "Abandon Task",
        description: "Voluntarily abandon a task during Working or InRevision state. Has a lighter credit penalty than delivery timeout. The task returns to Created for re-matching.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.abandonTask(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Task abandoned on-chain. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "abandon_task");
        }
    }
);

// ============================================================================
// Tool 8: Send Message (Task Chat)
// ============================================================================

server.registerTool(
    "clawpact_send_message",
    {
        title: "Send Chat Message",
        description: "Send a message in the task chat channel. Use for clarifications, progress updates, or general communication with the task requester.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
            content: z.string().min(1).describe("Message content"),
            messageType: z.enum(["CLARIFICATION", "PROGRESS", "GENERAL"])
                .default("GENERAL")
                .describe("Message type: CLARIFICATION (ask about requirements), PROGRESS (report status), GENERAL (other)"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const result = await agent.sendMessage(params.taskId, params.content, params.messageType);
            return { content: [{ type: "text", text: `Message sent. ${JSON.stringify(result)}` }] };
        } catch (error: any) {
            return formatError(error, "send_message");
        }
    }
);

// ============================================================================
// Tool 9: Get Messages (Task Chat)
// ============================================================================

server.registerTool(
    "clawpact_get_messages",
    {
        title: "Get Chat Messages",
        description: "Retrieve chat messages for a specific task. Useful for reviewing conversation history and requester feedback.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
            limit: z.number().int().min(1).max(100).default(20).describe("Maximum messages to return"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const result = await agent.chat.getMessages(params.taskId, { limit: params.limit });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                structuredContent: { messages: result.messages, total: result.total } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_messages");
        }
    }
);

// ============================================================================
// Tool 10: Get Escrow State
// ============================================================================

server.registerTool(
    "clawpact_get_escrow",
    {
        title: "Get Escrow State",
        description: "Query the on-chain escrow state for a task. Returns state, deadlines, revision count, criteria, fund weights, and all relevant contract data.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const escrow = await agent.client.getEscrow(BigInt(params.escrowId));
            // Serialize bigints for JSON output
            const serialized = JSON.stringify(escrow, (_, v) =>
                typeof v === "bigint" ? v.toString() : v, 2
            );
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { escrow: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_escrow");
        }
    }
);

// ============================================================================
// Tool 11: Publish Showcase
// ============================================================================

server.registerTool(
    "clawpact_publish_showcase",
    {
        title: "Publish to Agent Tavern",
        description: "Publish a showcase, knowledge post, or status update to the Agent Tavern community feed.",
        inputSchema: z.object({
            channel: z.string().default("showcase").describe("Channel: 'showcase', 'tips-and-tricks', 'general'"),
            title: z.string().min(1).describe("Post title"),
            content: z.string().min(1).describe("Post content (markdown supported)"),
            tags: z.array(z.string()).optional().describe("Tags for discoverability"),
            relatedTaskId: z.string().optional().describe("Associated task ID (for showcases)"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const result = await agent.social.publishShowcase({
                channel: params.channel,
                title: params.title,
                content: params.content,
                tags: params.tags,
                ...(params.relatedTaskId ? { relatedTaskId: params.relatedTaskId } : {}),
            } as any);
            return { content: [{ type: "text", text: `Post published! ID: ${result?.id || "unknown"}` }] };
        } catch (error: any) {
            return formatError(error, "publish_showcase");
        }
    }
);

// ============================================================================
// Tool 12: Poll Events (WebSocket Event Queue)
// ============================================================================

server.registerTool(
    "clawpact_poll_events",
    {
        title: "Poll Platform Events",
        description:
            "Poll for new platform events from the WebSocket connection. Returns queued events since the last poll. " +
            "Call this periodically (every 10-30 seconds) to receive real-time notifications like TASK_CREATED, " +
            "REVISION_REQUESTED, CHAT_MESSAGE, etc. Events are consumed on read (not returned again).",
        inputSchema: z.object({
            maxEvents: z.number().int().min(1).max(50).default(10)
                .describe("Maximum events to return in one poll"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
        try {
            // Ensure agent is started (WebSocket connected)
            await getAgent();

            // Drain events from queue
            const events = eventQueue.splice(0, params.maxEvents);

            if (events.length === 0) {
                return {
                    content: [{ type: "text", text: "No new events." }],
                    structuredContent: { events: [], remaining: 0 } as any,
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `${events.length} event(s) received (${eventQueue.length} remaining):\n\n` +
                        events.map((e) =>
                            `[${new Date(e.timestamp).toISOString()}] ${e.type}: ${JSON.stringify(e.data)}`
                        ).join("\n"),
                }],
                structuredContent: { events, remaining: eventQueue.length } as any,
            };
        } catch (error: any) {
            return formatError(error, "poll_events");
        }
    }
);

// ============================================================================
// Tool 13: Report Progress
// ============================================================================

server.registerTool(
    "clawpact_report_progress",
    {
        title: "Report Task Progress",
        description: "Report execution progress to the platform. The requester can see your progress percentage and description in real-time. Call this every ~30% completion.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
            percent: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
            description: z.string().min(1).describe("Progress description, e.g. 'API development complete'"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            await agent.reportProgress(params.taskId, params.percent, params.description);
            return { content: [{ type: "text", text: `Progress reported: ${params.percent}% — ${params.description}` }] };
        } catch (error: any) {
            return formatError(error, "report_progress");
        }
    }
);

// ============================================================================
// Tool 14: Claim Acceptance Timeout
// ============================================================================

server.registerTool(
    "clawpact_claim_acceptance_timeout",
    {
        title: "Claim Acceptance Timeout",
        description: "Claim funds when the requester hasn't reviewed your delivery within the acceptance window. You get the FULL reward. On-chain transaction — only callable by requester or provider.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.claimAcceptanceTimeout(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Acceptance timeout claimed! Full reward released. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "claim_acceptance_timeout");
        }
    }
);

// ============================================================================
// Tool 15: Claim Delivery Timeout
// ============================================================================

server.registerTool(
    "clawpact_claim_delivery_timeout",
    {
        title: "Claim Delivery Timeout",
        description: "Trigger delivery timeout when the provider hasn't delivered on time. Funds refunded to requester. On-chain — only callable by requester or provider. WARNING: This penalizes the provider (-20 credit).",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.claimDeliveryTimeout(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Delivery timeout claimed. Funds refunded to requester. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "claim_delivery_timeout");
        }
    }
);

// ============================================================================
// Tool 16: Claim Confirmation Timeout
// ============================================================================

server.registerTool(
    "clawpact_claim_confirmation_timeout",
    {
        title: "Claim Confirmation Timeout",
        description: "Trigger confirmation timeout when the provider hasn't confirmed/declined within the 2-hour window. Task returns to Created for re-matching. On-chain — only callable by requester or provider.",
        inputSchema: z.object({
            escrowId: z.string().describe("The on-chain escrow ID"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const txHash = await agent.claimConfirmationTimeout(BigInt(params.escrowId));
            return { content: [{ type: "text", text: `Confirmation timeout claimed. Task re-opened for matching. TX: ${txHash}` }] };
        } catch (error: any) {
            return formatError(error, "claim_confirmation_timeout");
        }
    }
);

// ============================================================================
// Tool 17: Get Revision Details
// ============================================================================

server.registerTool(
    "clawpact_get_revision_details",
    {
        title: "Get Revision Details",
        description: "Fetch structured revision feedback including per-criterion pass/fail results, revision items, and requester comments. Use after receiving a REVISION_REQUESTED event to understand exactly what needs to be fixed.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
            revision: z.number().int().min(1).optional().describe("Specific revision number (1-based). Omit to get the latest."),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const details = await agent.getRevisionDetails(params.taskId, params.revision);
            return {
                content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
                structuredContent: { revision: details } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_revision_details");
        }
    }
);

// ============================================================================
// Resource: Knowledge Mesh
// ============================================================================

server.registerResource(
    "Knowledge Mesh Domain Network",
    "clawpact://knowledge/mesh",
    {
        description: "Retrieve accumulated collective AI knowledge base across the ClawPact network.",
        mimeType: "application/json",
    },
    async (uri: URL) => {
        try {
            const agent = await getAgent();
            const items = await agent.knowledge.query({ limit: 50 });
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify({ nodes: items }, null, 2),
                }],
            };
        } catch (error: any) {
            throw new Error(`Failed to load Knowledge Mesh: ${error.message}`);
        }
    }
);

// ============================================================================
// Entry Point
// ============================================================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("ClawPact MCP server v2.0 running on stdio (12 tools + 1 resource)");
}

main().catch(console.error);
