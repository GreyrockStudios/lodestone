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

import { generateText, streamText } from 'ai';
import type { ModelMessage } from 'ai';
import type { LodestoneEngine } from './engine.js';
import type { StreamHandler } from './streaming/handler.js';
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
        role: 'assistant' as const,
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
        const toolContent = result.success
          ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
          : `Error: ${result.error}`;
        messages.push({
          role: 'user' as const,
          content: `[Tool: ${result.toolName}] ${toolContent}`,
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

  private buildMessageHistory(sessionId: string, systemPrompt: string): ModelMessage[] {
    const session = this.engine.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of session.messages) {
      if (msg.compacted) continue; // Skip compacted messages
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    return messages;
  }

  // ─── LLM Call ──────────────────────────────────────────────────────────

  private async callLLM(
    messages: ModelMessage[],
    streamHandler?: StreamHandler
  ): Promise<LLMResponse> {
    const provider = this.engine.llm.getDefault();
    const model = provider.getModel();

    // AI SDK v6: system messages must go in the 'system' option, not in messages
    let systemPrompt: string | undefined;
    const chatMessages: ModelMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      } else {
        chatMessages.push(msg);
      }
    }

    if (this.config.stream && streamHandler) {
      // Streaming mode
      const result = await streamText({
        model,
        system: systemPrompt,
        messages: chatMessages,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      let fullText = '';
      let toolCalls: ParsedToolCall[] = [];

      for await (const event of result.fullStream) {
        if (event.type === 'text-delta') {
          // AI SDK v6 uses event.text instead of event.textDelta
          const delta = (event as any).text || (event as any).textDelta || '';
          fullText += delta;
          streamHandler.emit('text_delta', { text: delta });
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: (event as any).args || (event as any).input as Record<string, unknown>,
          });
          streamHandler.emit('tool_call_start', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
        }
      }

      const usage = await result.usage;

      return {
        text: fullText,
        toolCalls,
        tokenCount: usage?.totalTokens,
      };
    } else {
      // Non-streaming mode
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: chatMessages,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const toolCalls: ParsedToolCall[] = (result.toolCalls || []).map(tc => ({
        toolCallId: tc.toolCallId || `tc_${Date.now()}`,
        toolName: tc.toolName,
        arguments: typeof (tc as any).args === 'string' ? JSON.parse((tc as any).args) : ((tc as any).args || (tc as any).input) as Record<string, unknown>,
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
    const identity = await this.engine.identity.load();

    for (const tc of toolCalls) {
      const startTime = Date.now();

      // Build tool context
      const context: import('./tools/definitions.js').ToolContext = {
        sessionId,
        workspaceRoot: this.engine.config.workspaceRoot,
        identity: {
          name: identity.identity.name,
          soul: identity.soul,
          rules: identity.rules.raw,
          heartbeat: identity.heartbeat.raw,
          user: identity.user.name,
        },
        memory: {
          store: async (key: string, value: string, metadata?: Record<string, unknown>) =>
            this.engine.memory.vector.store(key, value, metadata),
          recall: async (query: string, limit?: number) =>
            this.engine.memory.vector.recall(query, limit),
          wikiRead: async (slug: string) => {
            const page = await this.engine.memory.wiki.read(slug);
            return page ? page.content : null;
          },
          wikiWrite: async (slug: string, content: string, frontmatter?: Record<string, unknown>) => {
            await this.engine.memory.wiki.write(slug, content, frontmatter as any);
          },
          wikiSearch: async (query: string, limit?: number) =>
            this.engine.memory.wiki.search(query, limit),
          scratchGet: async (key: string) =>
            this.engine.memory.scratch.scratchGet(key),
          scratchSet: async (key: string, value: string, ttlMs?: number) =>
            this.engine.memory.scratch.scratchSet(key, value, ttlMs),
        },
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
      });

      this.engine.emit({
        type: 'tool.completed',
        sessionId,
        toolId: tc.toolName,
        durationMs: result.durationMs,
      });
    }

    return results;
  }

  // ─── Auto-Capture ──────────────────────────────────────────────────────

  private async autoCapture(userMessage: string, assistantResponse: string): Promise<void> {
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
      const summaryParts: string[] = [];
      let decisions: string[] = [];
      let keyFacts: string[] = [];

      for (const msg of messages) {
        if (msg.role === 'tool') {
          const content = msg.content.toLowerCase();
          if (content.includes('decision') || content.includes('decided')) {
            decisions.push(msg.content.slice(0, 200));
          }
        }
        if (msg.role === 'assistant') {
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

      return summaryParts.join('\n\n') || 'Previous conversation was compacted.';
    });
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