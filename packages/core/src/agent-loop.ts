/**
 * Lodestone Core — Agent Loop
 *
 * The core execution cycle:
 * 1. Receive user message
 * 2. Construct system prompt (identity + memory + rules)
 * 3. Send to LLM
 * 4. Parse response for tool calls
 * 5. Execute tool calls
 * 6. Feed results back to LLM
 * 7. Stream final response to user
 * 8. Update memory (auto-store if configured)
 *
 * This is the heart of the engine.
 */

import { generateText, streamText, type CoreMessage, type ToolCallPart, type ToolResultPart } from 'ai';
import type { LodestoneEngine } from './engine.js';
import type { SessionMessage } from './session/manager.js';
import type { StreamHandler, StreamEvent } from './streaming/handler.js';
import type { ToolResult } from './tools/definitions.js';

// ─── Agent Loop Config ────────────────────────────────────────────────────

export interface AgentLoopConfig {
  /** Maximum tool call iterations per turn (prevents infinite loops) */
  maxToolRounds: number;
  /** Maximum tokens for LLM response */
  maxTokens: number;
  /** Temperature for LLM generation */
  temperature: number;
  /** Whether to stream responses */
  stream: boolean;
  /** Whether to auto-store important facts in memory */
  autoCapture: boolean;
  /** Whether to auto-recall relevant memories on each turn */
  autoRecall: boolean;
  /** Maximum memories to inject into context */
  maxRecallResults: number;
  /** Maximum characters of wiki content to inject */
  maxWikiChars: number;
  /** System prompt template — {identity}, {memories}, {rules} are replaced */
  systemPromptTemplate: string;
}

const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  maxToolRounds: 10,
  maxTokens: 8192,
  temperature: 0.7,
  stream: true,
  autoCapture: false,
  autoRecall: true,
  maxRecallResults: 5,
  maxWikiChars: 2000,
  systemPromptTemplate: `{identity}

{memories}

{rules}`,
};

// ─── Agent Loop ────────────────────────────────────────────────────────────

export class AgentLoop {
  private engine: LodestoneEngine;
  private config: AgentLoopConfig;

  constructor(engine: LodestoneEngine, config?: Partial<AgentLoopConfig>) {
    this.engine = engine;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
  }

  /**
   * Run one turn of the agent loop.
   * Returns the full response text and any tool calls made.
   */
  async run(
    sessionId: string,
    userMessage: string,
    streamHandler?: StreamHandler
  ): Promise<AgentLoopResult> {
    const session = this.engine.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const startTime = Date.now();
    let totalTokens = 0;
    let toolCallsMade: ToolCallRecord[] = [];

    // 1. Add user message to session
    this.engine.sessions.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
      tokenCount: Math.ceil(userMessage.length / 4),
    });

    // 2. Construct system prompt
    const systemPrompt = await this.buildSystemPrompt(sessionId);

    // 3. Build message history
    const messages = this.buildMessageHistory(sessionId, systemPrompt);

    // 4. Agent loop: LLM → tool calls → results → repeat
    let currentResponse = '';
    let rounds = 0;

    while (rounds < this.config.maxToolRounds) {
      rounds++;

      // Call LLM
      const llmResponse = await this.callLLM(messages, streamHandler);

      totalTokens += llmResponse.tokenCount || 0;
      currentResponse = llmResponse.text;

      // Add assistant message to history
      messages.push({
        role: 'assistant',
        content: llmResponse.text,
      });

      // Check for tool calls in the response
      if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
        // No tool calls — we're done
        break;
      }

      // Execute tool calls
      const toolResults = await this.executeToolCalls(
        sessionId,
        llmResponse.toolCalls,
        streamHandler
      );

      // Record tool calls
      toolCallsMade.push(...toolResults.map(r => ({
        toolId: r.toolId,
        toolName: r.toolName,
        success: r.success,
        durationMs: r.durationMs,
        summary: r.summary,
      })));

      // Add tool results to message history
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          content: result.success
            ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
            : `Error: ${result.error}`,
          toolCallId: result.toolId,
          toolName: result.toolName,
        });
      }

      // Emit tool results event
      for (const result of toolResults) {
        streamHandler?.emit('tool_result', {
          toolCallId: result.toolId,
          toolName: result.toolName,
          success: result.success,
          result: result.summary,
          durationMs: result.durationMs,
        });
      }
    }

    // 5. Add final assistant message to session
    this.engine.sessions.addMessage(sessionId, {
      role: 'assistant',
      content: currentResponse,
      tokenCount: Math.ceil(currentResponse.length / 4),
    });

    // 6. Auto-capture if configured
    if (this.config.autoCapture) {
      await this.autoCapture(userMessage, currentResponse);
    }

    // 7. Check for context compaction
    if (this.engine.sessions.needsCompaction(sessionId)) {
      await this.compactSession(sessionId);
    }

    // 8. Emit completion event
    streamHandler?.emit('done', {
      totalTokens,
      finishReason: rounds >= this.config.maxToolRounds ? 'tool_limit' : 'complete',
    });

    return {
      response: currentResponse,
      toolCalls: toolCallsMade,
      totalTokens,
      rounds,
      durationMs: Date.now() - startTime,
    };
  }

  // ─── System Prompt Construction ─────────────────────────────────────────

  private async buildSystemPrompt(sessionId: string): Promise<string> {
    const session = this.engine.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Load identity
    const identity = await this.engine.identity.load();

    // Auto-recall relevant memories
    let memoriesSection = '';
    if (this.config.autoRecall) {
      const lastUserMessage = session.messages
        .filter(m => m.role === 'user')
        .pop()?.content || '';

      if (lastUserMessage) {
        const results = await this.engine.memory.smartRetrieve(
          lastUserMessage,
          this.config.maxRecallResults
        );

        if (results.wiki.length > 0 || results.memories.length > 0) {
          const parts: string[] = ['## Relevant Context\n'];

          if (results.wiki.length > 0) {
            parts.push('### Wiki');
            for (const page of results.wiki) {
              parts.push(`- [[${page.slug}]] — ${page.title}: ${page.excerpt}`);
            }
          }

          if (results.memories.length > 0) {
            parts.push('\n### Memories');
            for (const mem of results.memories) {
              parts.push(`- ${mem.text}`);
            }
          }

          memoriesSection = parts.join('\n');
        }
      }
    }

    // Build the full system prompt
    let prompt = this.config.systemPromptTemplate;
    prompt = prompt.replace('{identity}', identity.systemPrompt);
    prompt = prompt.replace('{memories}', memoriesSection);
    prompt = prompt.replace('{rules}', identity.rules.raw || '');

    // Append session state if available
    const state = await this.engine.memory.loadSessionState();
    if (state) {
      prompt += `\n\n## Resumed Session\n- Current task: ${state.currentTask}\n- Progress: ${state.progress}`;
      if (state.blockedBy) prompt += `\n- Blocked by: ${state.blockedBy}`;
      if (state.nextSteps.length > 0) prompt += `\n- Next steps: ${state.nextSteps.join(', ')}`;
    }

    return prompt;
  }

  // ─── Message History ────────────────────────────────────────────────────

  private buildMessageHistory(sessionId: string, systemPrompt: string): CoreMessage[] {
    const session = this.engine.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const messages: CoreMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of session.messages) {
      if (msg.compacted) continue; // Skip compacted messages (they're in the system prompt)
      messages.push({
        role: msg.role as 'user' | 'assistant' | 'tool',
        content: msg.content,
      });
    }

    return messages;
  }

  // ─── LLM Call ──────────────────────────────────────────────────────────

  private async callLLM(
    messages: CoreMessage[],
    streamHandler?: StreamHandler
  ): Promise<LLMResponse> {
    const provider = this.engine.llm.getDefault();
    const model = provider.getModel();

    // Build tool definitions for the LLM
    const toolDefs = this.engine.tools.listDefinitions();

    // Convert our tool definitions to AI SDK format
    const tools: Record<string, unknown> = {};
    for (const def of toolDefs) {
      tools[def.id] = {
        description: def.description,
        parameters: this.convertToolParams(def.parameters),
      };
    }

    if (this.config.stream && streamHandler) {
      // Streaming mode
      const result = await streamText({
        model,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      let fullText = '';
      let toolCalls: ParsedToolCall[] = [];

      for await (const event of result.fullStream) {
        if (event.type === 'text-delta') {
          fullText += event.textDelta;
          streamHandler.emit('text_delta', { text: event.textDelta });
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.args,
          });
          streamHandler.emit('tool_call_start', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
        } else if (event.type === 'tool-result') {
          streamHandler.emit('tool_call_end', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: JSON.stringify(event.args),
          });
        }
      }

      return {
        text: fullText,
        toolCalls,
        tokenCount: result.usage?.totalTokens,
      };
    } else {
      // Non-streaming mode
      const result = await generateText({
        model,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const toolCalls: ParsedToolCall[] = (result.toolCalls || []).map(tc => ({
        toolCallId: tc.toolCallId || `tc_${Date.now()}`,
        toolName: tc.toolName,
        arguments: typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args,
      }));

      return {
        text: result.text,
        toolCalls,
        tokenCount: result.usage?.totalTokens,
      };
    }
  }

  // ─── Tool Execution ─────────────────────────────────────────────────────

  private async executeToolCalls(
    sessionId: string,
    toolCalls: ParsedToolCall[],
    streamHandler?: StreamHandler
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];

    for (const tc of toolCalls) {
      const startTime = Date.now();

      // Build tool context
      const identity = await this.engine.identity.load();
      const context: import('../tools/definitions.js').ToolContext = {
        sessionId,
        workspaceRoot: this.engine.config.workspaceRoot,
        identity: {
          name: identity.identity.name,
          soul: identity.soul,
          rules: identity.rules.raw,
          heartbeat: identity.heartbeat.raw,
          user: identity.user.name,
        },
        memory: this.engine.memory,
        log: {
          info: (msg: string, data?: unknown) => console.log(`[Lodestone:${tc.toolName}] ${msg}`, data || ''),
          warn: (msg: string, data?: unknown) => console.warn(`[Lodestone:${tc.toolName}] ${msg}`, data || ''),
          error: (msg: string, data?: unknown) => console.error(`[Lodestone:${tc.toolName}] ${msg}`, data || ''),
        },
      };

      // Execute the tool
      const result = await this.engine.tools.execute(tc.toolName, tc.arguments, context);

      results.push({
        toolId: tc.toolCallId,
        toolName: tc.toolName,
        success: result.success,
        data: result.data,
        summary: result.summary,
        error: result.error,
        durationMs: Date.now() - startTime,
      });

      // Emit progress
      this.engine.emit({
        type: 'tool.called',
        sessionId,
        toolId: tc.toolName,
      } as import('./engine.js').EngineEvent);

      this.engine.emit({
        type: 'tool.completed',
        sessionId,
        toolId: tc.toolName,
        durationMs: result.durationMs,
      } as import('./engine.js').EngineEvent);
    }

    return results;
  }

  // ─── Auto-Capture ──────────────────────────────────────────────────────

  private async autoCapture(userMessage: string, assistantResponse: string): Promise<void> {
    // Store the fact that this conversation happened
    const summary = `${userMessage.slice(0, 100)}... → ${assistantResponse.slice(0, 100)}`;
    await this.engine.memory.vector.store(
      `conv_${Date.now()}`,
      summary,
      { category: 'fact', importance: 0.5 }
    );
  }

  // ─── Context Compaction ─────────────────────────────────────────────────

  private async compactSession(sessionId: string): Promise<void> {
    await this.engine.sessions.compact(sessionId, async (messages) => {
      // Build a summary of the compacted messages
      const summaryParts: string[] = [];
      let decisions: string[] = [];
      let keyFacts: string[] = [];
      let filesModified: string[] = [];

      for (const msg of messages) {
        if (msg.role === 'tool') {
          // Extract tool results
          const content = msg.content.toLowerCase();
          if (content.includes('decision') || content.includes('decided')) {
            decisions.push(msg.content.slice(0, 200));
          }
          if (content.includes('file') || content.includes('wrote') || content.includes('edited')) {
            filesModified.push(msg.content.slice(0, 100));
          }
        }
        if (msg.role === 'assistant') {
          // Extract key statements
          const sentences = msg.content.split(/[.!?]+/).filter(s => s.trim().length > 20);
          keyFacts.push(...sentences.slice(0, 3));
        }
      }

      if (decisions.length > 0) {
        summaryParts.push('### Decisions Made\n' + decisions.join('\n'));
      }
      if (keyFacts.length > 0) {
        summaryParts.push('### Key Facts\n' + keyFacts.join('\n'));
      }
      if (filesModified.length > 0) {
        summaryParts.push('### Files Modified\n' + filesModified.join('\n'));
      }

      return summaryParts.join('\n\n') || 'Previous conversation was compacted.';
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private convertToolParams(params: import('../tools/definitions.js').ToolParameter[]): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {},
      required: [] as string[],
    };

    for (const param of params) {
      (schema.properties as Record<string, unknown>)[param.name] = {
        type: param.type,
        description: param.description,
      };
      if (param.enum) {
        (schema.properties as Record<string, unknown>)[param.name] = {
          ...((schema.properties as Record<string, unknown>)[param.name] as object),
          enum: param.enum,
        };
      }
      if (param.required) {
        (schema.required as string[]).push(param.name);
      }
    }

    return schema;
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface LLMResponse {
  text: string;
  toolCalls: ParsedToolCall[];
  tokenCount?: number;
}

interface ParsedToolCall {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface ToolCallResult {
  toolId: string;
  toolName: string;
  success: boolean;
  data: unknown;
  summary: string;
  error?: string;
  durationMs: number;
}

export interface AgentLoopResult {
  response: string;
  toolCalls: ToolCallRecord[];
  totalTokens: number;
  rounds: number;
  durationMs: number;
}

export interface ToolCallRecord {
  toolId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  summary: string;
}