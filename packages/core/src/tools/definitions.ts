/**
 * Lodestone Core — Tool Definition & Execution
 *
 * Defines the tool interface that all Lodestone tools implement.
 * Tools are the agent's hands — they let it read, write, search, and act.
 */

import { z } from 'zod';
import { jsonSchema, tool as aiTool } from 'ai';

// ─── Tool Definition ───────────────────────────────────────────────────────

export interface ToolParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  items?: ToolParameter; // For array types
  properties?: Record<string, ToolParameter>; // For object types
  enum?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  /** Unique tool identifier (e.g., 'wiki-resolve', 'decision-log-add') */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this tool does */
  description: string;
  /** Parameter schema */
  parameters: ToolParameter[];
  /** Whether this tool modifies state (vs read-only) */
  sideEffects: boolean;
  /** Whether this tool requires user approval before execution */
  requiresApproval: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

// ─── Tool Result ────────────────────────────────────────────────────────────

export interface ToolResult {
  /** Whether the tool call succeeded */
  success: boolean;
  /** The result data (string, object, etc.) */
  data: unknown;
  /** Human-readable summary of what happened */
  summary: string;
  /** Error message if success is false */
  error?: string;
  /** Duration in ms */
  durationMs: number;
  /** Whether the result should be included in the LLM context */
  includeInContext: boolean;
}

// ─── Tool Interface ─────────────────────────────────────────────────────────

export interface Tool {
  /** Tool metadata and parameter schema */
  definition: ToolDefinition;
  /** Execute the tool with given parameters */
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// ─── Tool Context ────────────────────────────────────────────────────────────

export interface ToolContext {
  /** The session this tool call belongs to */
  sessionId: string;
  /** Workspace root directory */
  workspaceRoot: string;
  /** The agent's identity (SOUL, rules, etc.) */
  identity: AgentIdentity;
  /** Access to the memory system */
  memory: MemoryAccess;
  /** Access to the engine (for coordinator, safety, improvement systems) */
  engine?: any;
  /** Logger */
  log: ToolLogger;
}

export interface AgentIdentity {
  name: string;
  soul: string;
  rules: string;
  heartbeat: string;
  user: string;
}

export interface MemoryAccess {
  /** Store a fact in long-term memory */
  store(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Recall facts from long-term memory */
  recall(query: string, limit?: number): Promise<MemoryResult[]>;
  /** Read a wiki page */
  wikiRead(slug: string): Promise<string | null>;
  /** Write/update a wiki page */
  wikiWrite(slug: string, content: string, frontmatter?: Record<string, unknown>): Promise<void>;
  /** Search wiki pages */
  wikiSearch(query: string, limit?: number): Promise<WikiSearchResult[]>;
  /** Get/set scratch buffer values (session-scoped) */
  scratchGet(key: string): Promise<string | null>;
  scratchSet(key: string, value: string, ttlMs?: number): Promise<void>;
}

export interface MemoryResult {
  text: string;
  relevance: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface WikiSearchResult {
  slug: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface ToolLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ─── Tool Registry ──────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /** Register a tool */
  register(tool: Tool): void {
    this.tools.set(tool.definition.id, tool);
  }

  /** Get a tool by ID */
  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  /** List all registered tool definitions */
  listDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /** Execute a tool by ID */
  async execute(
    toolId: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return {
        success: false,
        data: null,
        summary: `Unknown tool: ${toolId}`,
        error: `Tool '${toolId}' is not registered`,
        durationMs: 0,
        includeInContext: true,
      };
    }

    const start = Date.now();
    try {
      // Enforce tool timeout if specified (default: 30s)
      const timeoutMs = tool.definition.timeout ?? 30000;
      const result = await Promise.race([
        tool.execute(params, context),
        new Promise<ToolResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool '${toolId}' timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return { ...result, durationMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Tool '${toolId}' threw an error`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  /** Check if approval is required for a tool */
  requiresApproval(toolId: string): boolean {
    const tool = this.tools.get(toolId);
    return tool?.definition.requiresApproval ?? true; // Default to requiring approval
  }

  /** Convert all registered tools to AI SDK v6 tool format (for LLM discovery only — execution stays in Lodestone) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK ToolSet requires flexible typing
  toAISDKTools(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [id, tool] of this.tools) {
      const def = tool.definition;
      // Build JSON Schema from parameters
      const properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description: string }> = {};
      const required: string[] = [];
      for (const param of def.parameters) {
        properties[param.name] = {
          type: param.type as 'string' | 'number' | 'boolean' | 'array' | 'object',
          description: param.description,
        };
        if (param.required) required.push(param.name);
      }
      // No execute() — Lodestone's executeToolCalls handles execution with safety checks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result[id] = {
        description: def.description,
        inputSchema: jsonSchema({
          type: 'object' as const,
          properties,
          required: required.length > 0 ? required : undefined,
        }),
      } as any;
    }
    return result;
  }
}