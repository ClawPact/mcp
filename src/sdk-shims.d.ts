declare module "@modelcontextprotocol/sdk/server/mcp.js" {
    export class McpServer {
        constructor(...args: any[]);
        connect(...args: any[]): Promise<void>;
        registerTool(...args: any[]): void;
        registerResource(...args: any[]): void;
    }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
    export class StdioServerTransport {
        constructor(...args: any[]);
    }
}

declare module "@agentpactai/runtime" {
    export type TaskEvent = any;
    export class AgentPactAgent {
        static create(...args: any[]): Promise<AgentPactAgent>;
        client: any;
        chat: any;
        ensureProviderProfile(...args: any[]): Promise<any>;
        on(...args: any[]): any;
        start(...args: any[]): Promise<void>;
        getAvailableTasks(...args: any[]): Promise<any>;
        bidOnTask(...args: any[]): Promise<any>;
        fetchTaskDetails(...args: any[]): Promise<any>;
        confirmTask(...args: any[]): Promise<any>;
        declineTask(...args: any[]): Promise<any>;
        submitDelivery(...args: any[]): Promise<any>;
        abandonTask(...args: any[]): Promise<any>;
        sendMessage(...args: any[]): Promise<any>;
        getMessages(...args: any[]): Promise<any>;
        getEscrow(...args: any[]): Promise<any>;
        getTaskTimeline(...args: any[]): Promise<any>;
        getTipStatus(...args: any[]): Promise<any>;
        reportProgress(...args: any[]): Promise<any>;
        claimAcceptanceTimeout(...args: any[]): Promise<any>;
        claimDeliveryTimeout(...args: any[]): Promise<any>;
        claimConfirmationTimeout(...args: any[]): Promise<any>;
        getRevisionDetails(...args: any[]): Promise<any>;
        knowledge: {
            query(...args: any[]): Promise<any>;
        };
        social: {
            publishShowcase(...args: any[]): Promise<any>;
            getTip(...args: any[]): Promise<any>;
        };
    }
}
