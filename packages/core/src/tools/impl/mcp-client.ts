/**
 * Lodestone Tool — MCP Client
 *
 * Connect to external MCP (Model Context Protocol) servers.
 * Supports SSE transport for remote servers.
 * Maintains a static Map of connected servers across calls.
 * Uses @modelcontextprotocol/sdk (lazy import).
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// Minimal type declarations for MCP SDK
interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface StoredConnection {
  name: string;
  url: string;
  connection: McpClient;
  connectedAt: number;
}

export class McpClientTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'mcp-client',
    name: 'MCP Client',
    description: 'Connect to external MCP (Model Context Protocol) servers. List and call tools on connected servers.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: connect, disconnect, list-tools, call-tool, servers', required: true, enum: ['connect', 'disconnect', 'list-tools', 'call-tool', 'servers'] },
      { name: 'serverUrl', type: 'string', description: 'Server URL (for connect, SSE or stdio)', required: false },
      { name: 'serverName', type: 'string', description: 'Friendly name for the server', required: false },
      { name: 'toolName', type: 'string', description: 'Tool name (for call-tool)', required: false },
      { name: 'args', type: 'object', description: 'Arguments for the tool call', required: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 30000,
  };

  private static connections: Map<string, StoredConnection> = new Map();

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'connect':
          return await this.connect(params, start);
        case 'disconnect':
          return await this.disconnect(params, start);
        case 'list-tools':
          return await this.listTools(params, start);
        case 'call-tool':
          return await this.callTool(params, start);
        case 'servers':
          return this.listServers(start);
        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `MCP action "${action}" failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  // ─── Connect ──────────────────────────────────────────────

  private async connect(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const serverUrl = params.serverUrl as string;
    const serverName = (params.serverName as string) || serverUrl;

    if (!serverUrl) return this.missingParam('serverUrl', start);

    // Check if already connected
    if (McpClientTool.connections.has(serverName)) {
      return {
        success: true,
        data: { serverName, alreadyConnected: true },
        summary: `Already connected to "${serverName}"`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Lazy import MCP SDK
    let mcpClient: McpClient;
    try {
      // @ts-ignore — MCP SDK may not be installed
      const sdk = await import('@modelcontextprotocol/sdk/client/index.js');
      // @ts-ignore — MCP SDK transport module
      const transport = await import('@modelcontextprotocol/sdk/client/sse.js');

      // Create SSE transport and client
      const sseTransport = new transport.SSEClientTransport(new URL(serverUrl));
      mcpClient = new sdk.Client(
        { name: 'lodestone-mcp-client', version: '1.0.0' },
        { capabilities: {} }
      ) as unknown as McpClient;
      await mcpClient.connect(sseTransport);
    } catch (err) {
      // Check if the error is about missing module
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Cannot find module') || errMsg.includes('MODULE_NOT_FOUND')) {
        throw new Error(
          '@modelcontextprotocol/sdk is not installed. Install it with: npm install @modelcontextprotocol/sdk'
        );
      }
      throw err;
    }

    McpClientTool.connections.set(serverName, {
      name: serverName,
      url: serverUrl,
      connection: mcpClient,
      connectedAt: Date.now(),
    });

    return {
      success: true,
      data: { serverName, url: serverUrl, connected: true },
      summary: `Connected to MCP server "${serverName}" at ${serverUrl}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Disconnect ───────────────────────────────────────────

  private async disconnect(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const serverName = (params.serverName as string) || '';

    if (!serverName) return this.missingParam('serverName', start);

    const conn = McpClientTool.connections.get(serverName);
    if (!conn) {
      return {
        success: false, data: null,
        summary: `Server not connected: ${serverName}`,
        error: `No connection named "${serverName}"`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    await conn.connection.close();
    McpClientTool.connections.delete(serverName);

    return {
      success: true,
      data: { serverName, disconnected: true },
      summary: `Disconnected from "${serverName}"`,
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }

  // ─── List Tools ───────────────────────────────────────────

  private async listTools(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const serverName = params.serverName as string;
    if (!serverName) return this.missingParam('serverName', start);

    const conn = McpClientTool.connections.get(serverName);
    if (!conn) {
      return {
        success: false, data: null,
        summary: `Server not connected: ${serverName}`,
        error: `No connection named "${serverName}". Connect first.`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const result = await conn.connection.listTools();
    const tools = result.tools.map((t: McpToolInfo) => ({
      name: t.name,
      description: t.description,
    }));

    return {
      success: true,
      data: { serverName, tools, count: tools.length },
      summary: `Server "${serverName}" has ${tools.length} tool(s)`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Call Tool ────────────────────────────────────────────

  private async callTool(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const serverName = params.serverName as string;
    const toolName = params.toolName as string;
    const args = (params.args as Record<string, unknown>) || {};

    if (!serverName) return this.missingParam('serverName', start);
    if (!toolName) return this.missingParam('toolName', start);

    const conn = McpClientTool.connections.get(serverName);
    if (!conn) {
      return {
        success: false, data: null,
        summary: `Server not connected: ${serverName}`,
        error: `No connection named "${serverName}". Connect first.`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const result = await conn.connection.callTool(toolName, args);

    return {
      success: true,
      data: { serverName, toolName, result },
      summary: `Called tool "${toolName}" on "${serverName}"`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── List Servers ─────────────────────────────────────────

  private listServers(start: number): ToolResult {
    const servers = Array.from(McpClientTool.connections.entries()).map(([name, conn]) => ({
      name,
      url: conn.url,
      connectedAt: conn.connectedAt,
      uptime: Date.now() - conn.connectedAt,
    }));

    return {
      success: true,
      data: { servers, count: servers.length },
      summary: `${servers.length} MCP server(s) connected`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private missingParam(name: string, start: number): ToolResult {
    return {
      success: false, data: null,
      summary: `Missing required parameter: ${name}`,
      error: `Missing parameter: ${name}`,
      durationMs: Date.now() - start, includeInContext: false,
    };
  }
}