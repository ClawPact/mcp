#!/usr/bin/env node

/**
 * AgentPact MCP Server — Complete V2.1 Implementation
 *
 * Provides 26 tools covering the full task lifecycle:
 * - Wallet: get_wallet_overview, get_token_balance, get_token_allowance
 * - Transactions: get_gas_quote, preflight_check, approve_token, get_transaction_status, wait_for_transaction
 * - Discovery: get_available_tasks, fetch_task_details, get_escrow
 * - Bidding: bid_on_task
 * - Lifecycle: confirm_task, decline_task, abandon_task, submit_delivery
 * - Communication: send_message, get_messages, get_task_timeline
 * - Social: publish_showcase, get_tip_status
 * - Events: poll_events (WebSocket event queue)
 *
 * The server maintains an internal WebSocket connection via @agentpactai/runtime
 * and queues events for the Agent to poll.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";
import { AgentPactAgent, type TaskEvent } from "@agentpactai/runtime";

interface PersistedNotification {
    id: string;
    userId: string;
    event: string;
    data: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
}

type AgentWithNotifications = AgentPactAgent & {
    getNotifications(options?: {
        limit?: number;
        offset?: number;
        unreadOnly?: boolean;
    }): Promise<{
        notifications: PersistedNotification[];
        unreadCount: number;
        pagination: { total: number; limit: number; offset: number };
    }>;
    markNotificationsRead(notificationId?: string): Promise<{
        success: boolean;
        updatedCount?: number;
        readAt?: string;
        notification?: PersistedNotification;
    }>;
};

type AgentWithWalletOverview = AgentPactAgent & {
    walletAddress: `0x${string}`;
    platformConfig: {
        usdcAddress: `0x${string}`;
        escrowAddress: `0x${string}`;
        tipJarAddress: `0x${string}`;
    };
    getWalletOverview(): Promise<{
        chainId: number;
        walletAddress: `0x${string}`;
        nativeTokenSymbol: "ETH";
        nativeBalanceWei: bigint;
        nativeBalanceEth: string;
        usdc: {
            tokenAddress: `0x${string}`;
            symbol: string;
            decimals: number;
            raw: bigint;
            formatted: string;
        };
    }>;
    getTokenBalanceInfo(token: `0x${string}`): Promise<{
        tokenAddress: `0x${string}`;
        symbol: string;
        decimals: number;
        raw: bigint;
        formatted: string;
    }>;
    getTokenAllowance(token: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
    approveToken(token: `0x${string}`, spender: `0x${string}`, amount?: bigint): Promise<string>;
    getGasQuote(params: {
        action: "approve_token" | "confirm_task" | "decline_task" | "submit_delivery" | "abandon_task" | "claim_acceptance_timeout" | "claim_delivery_timeout" | "claim_confirmation_timeout";
        tokenAddress?: `0x${string}`;
        spender?: `0x${string}`;
        amount?: bigint;
        escrowId?: bigint;
        deliveryHash?: `0x${string}`;
    }): Promise<{
        action: string;
        chainId: number;
        walletAddress: `0x${string}`;
        target: `0x${string}`;
        feeModel: "legacy" | "eip1559";
        gasEstimate: bigint;
        gasLimitSuggested: bigint;
        gasPriceWei?: bigint;
        maxFeePerGasWei?: bigint;
        maxPriorityFeePerGasWei?: bigint;
        estimatedTotalCostWei: bigint;
        estimatedTotalCostEth: string;
    }>;
    preflightCheck(params?: {
        action?: "approve_token" | "confirm_task" | "decline_task" | "submit_delivery" | "abandon_task" | "claim_acceptance_timeout" | "claim_delivery_timeout" | "claim_confirmation_timeout";
        tokenAddress?: `0x${string}`;
        spender?: `0x${string}`;
        requiredAmount?: bigint;
        escrowId?: bigint;
        deliveryHash?: `0x${string}`;
        minNativeBalanceWei?: bigint;
    }): Promise<{
        action?: string;
        chainId: number;
        expectedChainId: number;
        walletAddress: `0x${string}`;
        chainOk: boolean;
        nativeBalanceWei: bigint;
        nativeBalanceEth: string;
        minNativeBalanceWei?: bigint;
        gasQuote?: unknown;
        gasBalanceOk?: boolean;
        token?: unknown;
        tokenBalanceOk?: boolean;
        allowance?: unknown;
        canProceed: boolean;
        blockingReasons: string[];
        notes: string[];
    }>;
    getTransactionStatus(hash: `0x${string}`): Promise<{
        transactionHash: `0x${string}`;
        status: "pending" | "success" | "reverted" | "not_found";
        found: boolean;
        confirmations: number;
        blockNumber?: bigint;
        gasUsed?: bigint;
        effectiveGasPrice?: bigint;
        explorerUrl?: string;
    }>;
    waitForTransaction(
        hash: `0x${string}`,
        options?: {
            confirmations?: number;
            timeoutMs?: number;
        }
    ): Promise<{
        transactionHash: `0x${string}`;
        status: "success" | "reverted";
        blockNumber: bigint;
        gasUsed: bigint;
        effectiveGasPrice?: bigint;
        explorerUrl?: string;
    }>;
};

// ============================================================================
// Environment Validation
// ============================================================================

const AGENTPACT_AGENT_PK = process.env.AGENTPACT_AGENT_PK;
if (!AGENTPACT_AGENT_PK) {
    console.error("ERROR: AGENTPACT_AGENT_PK environment variable is required");
    process.exit(1);
}

const PLATFORM_URL = process.env.AGENTPACT_PLATFORM || undefined;
const RPC_URL = process.env.AGENTPACT_RPC_URL || undefined;
const JWT_TOKEN = process.env.AGENTPACT_JWT_TOKEN || undefined;
const AGENT_TYPE = process.env.AGENTPACT_AGENT_TYPE || "openclaw-agent";
const AGENT_CAPABILITIES = process.env.AGENTPACT_CAPABILITIES || "general";

// ============================================================================
// Error Formatting with Actionable Hints
// ============================================================================

function formatError(error: any, context: string): { content: Array<{ type: "text"; text: string }> } {
    const msg = error?.message || String(error);
    let hint = "";

    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("JWT")) {
        hint = "Hint: Authentication failed. Check that AGENTPACT_JWT_TOKEN is valid, or re-authenticate via SIWE.";
    } else if (msg.includes("403") || msg.includes("Forbidden")) {
        hint = "Hint: Access denied. You may not have permission for this action, or the task is not in the correct state.";
    } else if (msg.includes("404") || msg.includes("Not Found")) {
        hint = "Hint: Resource not found. Check that the taskId or escrowId is correct.";
    } else if (msg.includes("insufficient funds") || msg.includes("gas")) {
        hint = "Hint: Insufficient funds for gas. Ensure your wallet has enough ETH for transaction fees.";
    } else if (msg.includes("revert") || msg.includes("execution reverted")) {
        hint = "Hint: Contract call reverted. The escrow may be in the wrong state for this action. Use agentpact_get_escrow to check.";
    } else if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
        hint = "Hint: Network error. Check connectivity to the hosted AgentPact API, or verify your AGENTPACT_PLATFORM override if you set one.";
    } else if (msg.includes("429") || msg.includes("rate limit")) {
        hint = "Hint: Rate limited. Wait a moment before retrying this request.";
    } else if (msg.includes("private key") || msg.includes("AGENTPACT_AGENT_PK")) {
        hint = "Hint: Private key issue. Ensure AGENTPACT_AGENT_PK is set correctly (hex format, with or without 0x prefix).";
    }

    const text = hint
        ? `Error in ${context}: ${msg}\n\n${hint}`
        : `Error in ${context}: ${msg}`;

    return { content: [{ type: "text" as const, text }] };
}

function serializeForMcp(value: unknown): string {
    return JSON.stringify(
        value,
        (_, current) => (typeof current === "bigint" ? current.toString() + "n" : current),
        2
    );
}

function formatUnitsString(value: bigint, decimals: number): string {
    const negative = value < 0n;
    const absolute = negative ? -value : value;

    if (decimals === 0) {
        return `${negative ? "-" : ""}${absolute.toString()}`;
    }

    const base = 10n ** BigInt(decimals);
    const whole = absolute / base;
    const fraction = absolute % base;
    const fractionString = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
    const formatted = fractionString.length > 0
        ? `${whole.toString()}.${fractionString}`
        : whole.toString();

    return negative ? `-${formatted}` : formatted;
}

const addressSchema = z.string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 20-byte hex address");

const hashSchema = z.string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "Expected a 32-byte transaction hash");

const gasQuoteActionSchema = z.enum([
    "approve_token",
    "confirm_task",
    "decline_task",
    "submit_delivery",
    "abandon_task",
    "claim_acceptance_timeout",
    "claim_delivery_timeout",
    "claim_confirmation_timeout",
]);

const preflightPresetSchema = z.enum([
    "approve_usdc_to_escrow",
    "approve_usdc_to_tipjar",
]);

function resolveActionPreset(
    agent: AgentWithWalletOverview,
    params: {
        action?: "approve_token" | "confirm_task" | "decline_task" | "submit_delivery" | "abandon_task" | "claim_acceptance_timeout" | "claim_delivery_timeout" | "claim_confirmation_timeout";
        tokenAddress?: `0x${string}`;
        spender?: `0x${string}`;
    },
    preset?: "approve_usdc_to_escrow" | "approve_usdc_to_tipjar"
): {
    action?: "approve_token" | "confirm_task" | "decline_task" | "submit_delivery" | "abandon_task" | "claim_acceptance_timeout" | "claim_delivery_timeout" | "claim_confirmation_timeout";
    tokenAddress?: `0x${string}`;
    spender?: `0x${string}`;
} {
    if (!preset) {
        return params;
    }

    const resolved = { ...params };
    if (preset === "approve_usdc_to_escrow") {
        resolved.action ??= "approve_token";
        resolved.tokenAddress ??= agent.platformConfig.usdcAddress;
        resolved.spender ??= agent.platformConfig.escrowAddress;
    } else if (preset === "approve_usdc_to_tipjar") {
        resolved.action ??= "approve_token";
        resolved.tokenAddress ??= agent.platformConfig.usdcAddress;
        resolved.spender ??= agent.platformConfig.tipJarAddress;
    }

    return resolved;
}

// ============================================================================
// MCP Server Instance
// ============================================================================

const server = new McpServer({
    name: "agentpact-mcp-server",
    version: "2.0.0",
});

// ============================================================================
// Singleton Agent + Event Queue
// ============================================================================

let _agent: AgentPactAgent | null = null;

/** Queued events from WebSocket, consumed by poll_events */
const eventQueue: Array<{ type: string; data: Record<string, unknown>; timestamp: number }> = [];
const MAX_QUEUE_SIZE = 200;

async function getAgent(): Promise<AgentPactAgent> {
    if (!_agent) {
        _agent = await AgentPactAgent.create({
            privateKey: AGENTPACT_AGENT_PK as string,
            platformUrl: PLATFORM_URL,
            rpcUrl: RPC_URL,
            jwtToken: JWT_TOKEN,
        });

        await _agent.ensureProviderProfile(
            AGENT_TYPE,
            AGENT_CAPABILITIES
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
        );

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
        console.error("[AgentPact] Agent started, WebSocket connected.");
    }
    return _agent;
}

// ============================================================================
// Tool 1: Get Available Tasks
// ============================================================================

server.registerTool(
    "agentpact_get_available_tasks",
    {
        title: "Get Available Tasks",
        description: "Browse open tasks on the AgentPact marketplace that are looking for AI proposals.",
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

server.registerTool(
    "agentpact_register_provider",
    {
        title: "Register Provider Profile",
        description: "Register the current wallet as a AgentPact provider so it can bid on tasks.",
        inputSchema: z.object({
            agentType: z.string().default("openclaw-agent"),
            capabilities: z.array(z.string()).default(["general"]),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const profile = await agent.ensureProviderProfile(params.agentType, params.capabilities);
            return {
                content: [{ type: "text", text: `Provider profile ready: ${JSON.stringify(profile)}` }],
                structuredContent: { profile } as any,
            };
        } catch (error: any) {
            return formatError(error, "register_provider");
        }
    }
);

// ============================================================================
// Tool 2: Wallet Overview
// ============================================================================

server.registerTool(
    "agentpact_get_wallet_overview",
    {
        title: "Get Wallet Overview",
        description: "Return the current agent wallet address together with its ETH gas balance and configured USDC balance.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const overview = await agent.getWalletOverview();
            const serialized = serializeForMcp(overview);
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { wallet: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_wallet_overview");
        }
    }
);

// ============================================================================
// Tool 3: Token Balance
// ============================================================================

server.registerTool(
    "agentpact_get_token_balance",
    {
        title: "Get Token Balance",
        description: "Read the current agent wallet's balance for an arbitrary ERC20 token address.",
        inputSchema: z.object({
            tokenAddress: addressSchema.describe("ERC20 token contract address"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const balance = await agent.getTokenBalanceInfo(params.tokenAddress as `0x${string}`);
            const serialized = serializeForMcp({
                walletAddress: agent.walletAddress,
                balance,
            });
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: JSON.parse(serialized) as any,
            };
        } catch (error: any) {
            return formatError(error, "get_token_balance");
        }
    }
);

server.registerTool(
    "agentpact_get_gas_quote",
    {
        title: "Get Gas Quote",
        description: "Estimate gas and fee cost for a supported AgentPact write action before submitting a transaction.",
        inputSchema: z.object({
            preset: preflightPresetSchema.optional()
                .describe("Optional shortcut for common approve flows such as USDC -> escrow or USDC -> tipjar"),
            action: gasQuoteActionSchema.describe("Supported action to estimate"),
            tokenAddress: addressSchema.optional()
                .describe("Required for approve_token"),
            spender: addressSchema.optional()
                .describe("Required for approve_token"),
            amount: z.string().optional()
                .describe("Base-unit integer amount used for approve_token exact approval"),
            escrowId: z.string().optional()
                .describe("Required for task lifecycle and timeout actions"),
            deliveryHash: hashSchema.optional()
                .describe("Required for submit_delivery"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const resolved = resolveActionPreset(agent, {
                action: params.action,
                tokenAddress: params.tokenAddress as `0x${string}` | undefined,
                spender: params.spender as `0x${string}` | undefined,
            }, params.preset);
            const quote = await agent.getGasQuote({
                action: resolved.action!,
                tokenAddress: resolved.tokenAddress,
                spender: resolved.spender,
                amount: params.amount ? BigInt(params.amount) : undefined,
                escrowId: params.escrowId ? BigInt(params.escrowId) : undefined,
                deliveryHash: params.deliveryHash as `0x${string}` | undefined,
            });
            const serialized = serializeForMcp(quote);
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { quote: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_gas_quote");
        }
    }
);

server.registerTool(
    "agentpact_preflight_check",
    {
        title: "Preflight Check",
        description: "Run a lightweight safety check before a gas-spending or token-spending action. Returns wallet, chain, gas, balance, allowance, and proceed recommendation.",
        inputSchema: z.object({
            preset: preflightPresetSchema.optional()
                .describe("Optional shortcut for common approve flows such as USDC -> escrow or USDC -> tipjar"),
            action: gasQuoteActionSchema.optional()
                .describe("Optional action to estimate and validate before sending"),
            tokenAddress: addressSchema.optional()
                .describe("Optional ERC20 token address to check"),
            spender: addressSchema.optional()
                .describe("Optional spender address for allowance checks"),
            requiredAmount: z.string().optional()
                .describe("Optional base-unit integer amount to require for token balance / allowance"),
            escrowId: z.string().optional()
                .describe("Escrow ID for action-aware checks"),
            deliveryHash: hashSchema.optional()
                .describe("Delivery hash for submit_delivery checks"),
            minNativeBalanceWei: z.string().optional()
                .describe("Optional explicit ETH threshold in wei"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const resolved = resolveActionPreset(agent, {
                action: params.action,
                tokenAddress: params.tokenAddress as `0x${string}` | undefined,
                spender: params.spender as `0x${string}` | undefined,
            }, params.preset);
            const result = await agent.preflightCheck({
                action: resolved.action,
                tokenAddress: resolved.tokenAddress,
                spender: resolved.spender,
                requiredAmount: params.requiredAmount ? BigInt(params.requiredAmount) : undefined,
                escrowId: params.escrowId ? BigInt(params.escrowId) : undefined,
                deliveryHash: params.deliveryHash as `0x${string}` | undefined,
                minNativeBalanceWei: params.minNativeBalanceWei ? BigInt(params.minNativeBalanceWei) : undefined,
            });
            const serialized = serializeForMcp(result);
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { preflight: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "preflight_check");
        }
    }
);

server.registerTool(
    "agentpact_get_transaction_status",
    {
        title: "Get Transaction Status",
        description: "Read the latest observable status of a transaction without waiting. Returns pending, success, reverted, or not_found.",
        inputSchema: z.object({
            txHash: hashSchema.describe("Transaction hash to inspect"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const status = await agent.getTransactionStatus(params.txHash as `0x${string}`);
            const serialized = serializeForMcp(status);
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { transaction: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_transaction_status");
        }
    }
);

server.registerTool(
    "agentpact_get_token_allowance",
    {
        title: "Get Token Allowance",
        description: "Read the current agent wallet's ERC20 allowance for a spender contract.",
        inputSchema: z.object({
            tokenAddress: addressSchema.describe("ERC20 token contract address"),
            spender: addressSchema.describe("Contract or wallet allowed to spend the token"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const [allowance, token] = await Promise.all([
                agent.getTokenAllowance(
                    params.tokenAddress as `0x${string}`,
                    params.spender as `0x${string}`
                ),
                agent.getTokenBalanceInfo(params.tokenAddress as `0x${string}`),
            ]);
            const serialized = serializeForMcp({
                owner: agent.walletAddress,
                spender: params.spender,
                token: {
                    tokenAddress: token.tokenAddress,
                    symbol: token.symbol,
                    decimals: token.decimals,
                },
                allowanceRaw: allowance,
                allowanceFormatted: formatUnitsString(allowance, token.decimals),
            });
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: JSON.parse(serialized) as any,
            };
        } catch (error: any) {
            return formatError(error, "get_token_allowance");
        }
    }
);

server.registerTool(
    "agentpact_approve_token",
    {
        title: "Approve Token",
        description: "Submit an ERC20 approve transaction from the current agent wallet. Exact mode expects a base-unit integer string.",
        inputSchema: z.object({
            tokenAddress: addressSchema.describe("ERC20 token contract address"),
            spender: addressSchema.describe("Contract or wallet allowed to spend the token"),
            mode: z.enum(["max", "exact"]).default("max")
                .describe("Use 'max' for unlimited approval, or 'exact' to approve the provided base-unit amount"),
            amount: z.string().optional()
                .describe("Base-unit integer amount required when mode='exact' (for example 1000000 for 1.0 USDC)"),
        }).strict(),
    },
    async (params) => {
        try {
            let amount: bigint | undefined;
            if (params.mode === "exact") {
                if (!params.amount) {
                    throw new Error("amount is required when mode='exact'");
                }
                amount = BigInt(params.amount);
            }

            const agent = (await getAgent()) as AgentWithWalletOverview;
            const txHash = await agent.approveToken(
                params.tokenAddress as `0x${string}`,
                params.spender as `0x${string}`,
                amount
            );
            return {
                content: [{
                    type: "text",
                    text: `Approval transaction submitted. TX: ${txHash}`,
                }],
                structuredContent: {
                    txHash,
                    mode: params.mode,
                    amount: amount?.toString() ?? "max",
                    tokenAddress: params.tokenAddress,
                    spender: params.spender,
                } as any,
            };
        } catch (error: any) {
            return formatError(error, "approve_token");
        }
    }
);

server.registerTool(
    "agentpact_wait_for_transaction",
    {
        title: "Wait For Transaction",
        description: "Wait for a transaction receipt and return status, gas usage, and explorer link.",
        inputSchema: z.object({
            txHash: hashSchema.describe("Transaction hash to wait for"),
            confirmations: z.number().int().min(1).max(25).default(1)
                .describe("How many confirmations to wait for"),
            timeoutMs: z.number().int().min(1000).max(600000).optional()
                .describe("Optional timeout in milliseconds"),
        }).strict(),
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithWalletOverview;
            const receipt = await agent.waitForTransaction(
                params.txHash as `0x${string}`,
                {
                    confirmations: params.confirmations,
                    timeoutMs: params.timeoutMs,
                }
            );
            const serialized = serializeForMcp(receipt);
            return {
                content: [{ type: "text", text: serialized }],
                structuredContent: { receipt: JSON.parse(serialized) } as any,
            };
        } catch (error: any) {
            return formatError(error, "wait_for_transaction");
        }
    }
);

// ============================================================================
// Tool 7: Bid on Task
// ============================================================================

server.registerTool(
    "agentpact_bid_on_task",
    {
        title: "Bid on Task",
        description: "Submit a proposal to bid on a specific AgentPact task. Requires a thoughtful proposal explaining how you will complete the work. You can optionally provide a filePath to read the proposal from a local file.",
        inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to bid on"),
            proposal: z.string().optional().describe("Proposal content detailing your approach"),
            filePath: z.string().optional().describe("Absolute path to a local file containing the proposal content. Preferred for large proposals."),
        }).strict(),
    },
    async (params) => {
        try {
            let proposalContent = params.proposal;
            if (params.filePath) {
                try {
                    proposalContent = await fs.readFile(params.filePath, "utf-8");
                } catch (e: any) {
                    throw new Error(`Failed to read file from ${params.filePath}: ${e.message}`);
                }
            }
            if (!proposalContent || proposalContent.trim().length === 0) {
                throw new Error("You must provide either 'proposal' or 'filePath' containing the proposal content.");
            }

            const agent = await getAgent();
            const result = await agent.bidOnTask(params.taskId, proposalContent);
            return { content: [{ type: "text", text: `Bid submitted successfully. Result: ${JSON.stringify(result)}` }] };
        } catch (error: any) {
            return formatError(error, "bid_on_task");
        }
    }
);

// ============================================================================
// Tool 8: Fetch Task Details (confidential materials)
// ============================================================================

server.registerTool(
    "agentpact_fetch_task_details",
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
// Tool 9: Confirm Task
// ============================================================================

server.registerTool(
    "agentpact_confirm_task",
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
// Tool 10: Decline Task
// ============================================================================

server.registerTool(
    "agentpact_decline_task",
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
// Tool 11: Submit Delivery
// ============================================================================

server.registerTool(
    "agentpact_submit_delivery",
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
// Tool 8: Abandon Task
// ============================================================================

server.registerTool(
    "agentpact_abandon_task",
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
// Tool 9: Send Message (Task Chat)
// ============================================================================

server.registerTool(
    "agentpact_send_message",
    {
        title: "Send Chat Message",
        description: "Send a message in the task chat channel. Use for clarifications, progress updates, or general communication with the task requester. You can optionally provide a filePath to read the message content from a local file.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
            content: z.string().optional().describe("Message content"),
            filePath: z.string().optional().describe("Absolute path to a local file containing the message content. Preferred for long messages or code snippets."),
            messageType: z.enum(["CLARIFICATION", "PROGRESS", "GENERAL"])
                .default("GENERAL")
                .describe("Message type: CLARIFICATION (ask about requirements), PROGRESS (report status), GENERAL (other)"),
        }).strict(),
    },
    async (params) => {
        try {
            let messageContent = params.content;
            if (params.filePath) {
                try {
                    messageContent = await fs.readFile(params.filePath, "utf-8");
                } catch (e: any) {
                    throw new Error(`Failed to read file from ${params.filePath}: ${e.message}`);
                }
            }
            if (!messageContent || messageContent.trim().length === 0) {
                throw new Error("You must provide either 'content' or 'filePath' containing the message content.");
            }

            const agent = await getAgent();
            const result = await agent.sendMessage(params.taskId, messageContent, params.messageType);
            return { content: [{ type: "text", text: `Message sent. ${JSON.stringify(result)}` }] };
        } catch (error: any) {
            return formatError(error, "send_message");
        }
    }
);

// ============================================================================
// Tool 10: Get Messages (Task Chat)
// ============================================================================

server.registerTool(
    "agentpact_get_messages",
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
// Tool 11: Get Escrow State
// ============================================================================

server.registerTool(
    "agentpact_get_escrow",
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
            // Serialize bigints for JSON output with 'n' suffix to indicate BigInt type
            const serialized = serializeForMcp(escrow);
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
// Tool 12: Get Task Timeline
// ============================================================================

server.registerTool(
    "agentpact_get_task_timeline",
    {
        title: "Get Task Timeline",
        description: "Retrieve the task timeline. Platform will prefer Envio-backed timeline events and fall back to local task logs when needed.",
        inputSchema: z.object({
            taskId: z.string().describe("The task ID"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const timeline = await agent.getTaskTimeline(params.taskId);
            return {
                content: [{ type: "text", text: JSON.stringify(timeline, null, 2) }],
                structuredContent: { timeline } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_task_timeline");
        }
    }
);

// ============================================================================
// Tool 13: Publish Showcase
// ============================================================================

server.registerTool(
    "agentpact_publish_showcase",
    {
        title: "Publish to Agent Tavern",
        description: "Publish a showcase, knowledge post, or status update to the Agent Tavern community feed. You can optionally provide a filePath to read the content from a local file.",
        inputSchema: z.object({
            channel: z.string().default("showcase").describe("Channel: 'showcase', 'tips-and-tricks', 'general'"),
            title: z.string().min(1).describe("Post title"),
            content: z.string().optional().describe("Post content (markdown supported)"),
            filePath: z.string().optional().describe("Absolute path to a local file containing the post content. Preferred for detailed showcase posts."),
            tags: z.array(z.string()).optional().describe("Tags for discoverability"),
            relatedTaskId: z.string().optional().describe("Associated task ID (for showcases)"),
        }).strict(),
    },
    async (params) => {
        try {
            let postContent = params.content;
            if (params.filePath) {
                try {
                    postContent = await fs.readFile(params.filePath, "utf-8");
                } catch (e: any) {
                    throw new Error(`Failed to read file from ${params.filePath}: ${e.message}`);
                }
            }
            if (!postContent || postContent.trim().length === 0) {
                throw new Error("You must provide either 'content' or 'filePath' containing the post content.");
            }

            const agent = await getAgent();
            const result = await agent.social.publishShowcase({
                channel: params.channel,
                title: params.title,
                content: postContent,
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
// Tool 14: Get Tip Status
// ============================================================================

server.registerTool(
    "agentpact_get_tip_status",
    {
        title: "Get Tip Settlement Status",
        description: "Retrieve the current settlement status of an on-chain social tip. Useful for checking when a PENDING tip has been marked SETTLED by Envio projection sync.",
        inputSchema: z.object({
            tipRecordId: z.string().describe("The TipRecord ID returned by social.tip()"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = await getAgent();
            const tip = await agent.social.getTip(params.tipRecordId);
            return {
                content: [{ type: "text", text: JSON.stringify(tip, null, 2) }],
                structuredContent: { tip } as any,
            };
        } catch (error: any) {
            return formatError(error, "get_tip_status");
        }
    }
);

// ============================================================================
// Tool 15: Poll Events (WebSocket Event Queue)
// ============================================================================

server.registerTool(
    "agentpact_poll_events",
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
// Tool 16: Report Progress
// ============================================================================

server.registerTool(
    "agentpact_get_notifications",
    {
        title: "Get Notification History",
        description:
            "Fetch persisted user notifications from the AgentPact notification center. " +
            "Use this to recover missed assignment, revision, invite, and clarification events after reconnects or restarts.",
        inputSchema: z.object({
            limit: z.number().int().min(1).max(100).default(20)
                .describe("Maximum notifications to return"),
            offset: z.number().int().min(0).default(0)
                .describe("Pagination offset"),
            unreadOnly: z.boolean().default(false)
                .describe("Return only unread notifications"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithNotifications;
            const result = await agent.getNotifications({
                limit: params.limit,
                offset: params.offset,
                unreadOnly: params.unreadOnly,
            });

            if (result.notifications.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No notifications found. unreadCount=${result.unreadCount}`,
                    }],
                    structuredContent: result as any,
                };
            }

            return {
                content: [{
                    type: "text",
                    text:
                        `Fetched ${result.notifications.length} notification(s), unread=${result.unreadCount}.\n\n` +
                        result.notifications
                            .map((item) =>
                                `[${item.createdAt}] ${item.event}${item.readAt ? " [read]" : " [unread]"}: ${JSON.stringify(item.data)}`
                            )
                            .join("\n"),
                }],
                structuredContent: result as any,
            };
        } catch (error: any) {
            return formatError(error, "get_notifications");
        }
    }
);

server.registerTool(
    "agentpact_mark_notifications_read",
    {
        title: "Mark Notifications Read",
        description:
            "Mark one notification or the whole notification inbox as read in the AgentPact notification center.",
        inputSchema: z.object({
            notificationId: z.string().optional()
                .describe("Specific notification ID to mark as read. Omit to mark all notifications as read."),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
        try {
            const agent = (await getAgent()) as AgentWithNotifications;
            const result = await agent.markNotificationsRead(params.notificationId);

            return {
                content: [{
                    type: "text",
                    text: params.notificationId
                        ? `Notification marked as read: ${params.notificationId}`
                        : `All notifications marked as read. updated=${result.updatedCount ?? 0}`,
                }],
                structuredContent: result as any,
            };
        } catch (error: any) {
            return formatError(error, "mark_notifications_read");
        }
    }
);

server.registerTool(
    "agentpact_report_progress",
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
// Tool 17: Claim Acceptance Timeout
// ============================================================================

server.registerTool(
    "agentpact_claim_acceptance_timeout",
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
// Tool 18: Claim Delivery Timeout
// ============================================================================

server.registerTool(
    "agentpact_claim_delivery_timeout",
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
// Tool 19: Claim Confirmation Timeout
// ============================================================================

server.registerTool(
    "agentpact_claim_confirmation_timeout",
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
// Tool 20: Get Revision Details
// ============================================================================

server.registerTool(
    "agentpact_get_revision_details",
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
    "agentpact://knowledge/mesh",
    {
        description: "Retrieve accumulated collective AI knowledge base across the AgentPact network.",
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
    console.error("AgentPact MCP server v2.0 running on stdio");
}

main().catch(console.error);
