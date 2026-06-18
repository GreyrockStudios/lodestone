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

import { generateText, streamText, jsonSchema, tool as aiTool } from 'ai';
import type { ModelMessage } from 'ai';
import type { LodestoneEngine } from './engine.js';
import type { StreamHandler } from './streaming/handler.js';
import type { WikiFrontmatter } from './memory/wiki-store.js';
import type { ToolResult } from './tools/definitions.js';
import type { CorrectionInput } from './safety/behavioral-learning.js';
import type { GateOutputType } from './safety/quality-gates.js';
import type { PluginHookEvent } from './plugin-system.js';
import { getLogger } from './utils/logger.js';

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
  private logger = getLogger('AgentLoop');

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

    // ─── Plugin Hook: onMessage ──────────────────────────────────────────
    try {
      await this.engine.executePluginHook('onMessage', sessionId, {
        content: userMessage,
        senderId: '',
        senderName: '',
        channelId: '',
      });
    } catch {
      // Plugin hooks are best-effort — never block the loop
    }

    // 1. Add user message to session
    this.engine.sessions.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
      tokenCount: Math.ceil(userMessage.length / 4),
    });

    // 1b. Check if this is a correction of a previous assistant response
    const previousMessages = session.messages;
    const lastAssistantMsg = previousMessages.filter(m => m.role === 'assistant').pop();
    if (lastAssistantMsg) {
      const correctionInput: CorrectionInput = {
        message: userMessage,
        precedingResponse: lastAssistantMsg.content,
        timestamp: new Date().toISOString(),
      };
      const extractedRule = this.engine.safety.processCorrection(correctionInput);
      if (extractedRule) {
        this.logger.info('Behavioral rule learned', { trigger: extractedRule.trigger, correctBehavior: extractedRule.correctBehavior });
      }
    }

    // 2. Construct system prompt
    const systemPrompt = await this.buildSystemPrompt(sessionId);

    // 3. Build message history
    const messages = this.buildMessageHistory(sessionId, systemPrompt);

    // 4. Agent loop: LLM → tool calls → results → repeat
    let currentResponse = '';
    let rounds = 0;

    // Plugin Hook: beforeResponse — allow plugins to modify the prompt before LLM call
    try {
      await this.engine.executePluginHook('beforeResponse', sessionId, {
        systemPrompt,
        messages: messages.length,
      });
    } catch {
      // Best-effort — don't block
    }

    try {
      while (rounds < this.config.maxToolRounds) {
        rounds++;

        // Call LLM
        const llmResponse = await this.callLLM(messages, streamHandler, sessionId);

      totalTokens += llmResponse.tokenCount || 0;
      currentResponse = llmResponse.text;

      // Add assistant message to history and session
      messages.push({
        role: 'assistant' as const,
        content: llmResponse.text,
      });
      this.engine.sessions.addMessage(sessionId, {
        role: 'assistant',
        content: llmResponse.text,
        tokenCount: Math.ceil(llmResponse.text.length / 4),
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

      // Add tool results to message history and session
      for (const result of toolResults) {
        const toolContent = result.success
          ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
          : `Error: ${result.error}`;
        const toolMsg = `[Tool: ${result.toolName}] ${toolContent}`;
        messages.push({
          role: 'user' as const,
          content: toolMsg,
        });
        // Persist to session for continuity
        this.engine.sessions.addMessage(sessionId, {
          role: 'user',
          content: toolMsg,
          tokenCount: Math.ceil(toolMsg.length / 4),
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
    } catch (err) {
      // Graceful degradation — if LLM fails completely, return a meaningful message
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent loop failed', { error: errorMsg, round: rounds });
      currentResponse = `I encountered an error processing your request: ${errorMsg}. Please try again or rephrase your message.`;
      this.engine.sessions.addMessage(sessionId, {
        role: 'assistant',
        content: currentResponse,
        tokenCount: Math.ceil(currentResponse.length / 4),
      });
    }

    // 5. Add final assistant message to session (if not already added in loop)
    const session2 = this.engine.sessions.get(sessionId);
    const lastMsg = session2?.messages[session2.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.content !== currentResponse) {
      this.engine.sessions.addMessage(sessionId, {
        role: 'assistant',
        content: currentResponse,
        tokenCount: Math.ceil(currentResponse.length / 4),
      });
    }

    // 5b. Quality gate review — determine output type and review if gated
    const outputType = this.detectOutputType(currentResponse);
    if (outputType && this.engine.safety.qualityGate.shouldGate(outputType)) {
      const gateResult = await this.engine.safety.qualityGate.review({
        output: currentResponse,
        type: outputType,
        request: userMessage,
      });
      this.logger.info('Quality gate result', { decision: gateResult.decision, score: gateResult.overallScore.toFixed(2), outputType });
      if (gateResult.issues.length > 0) {
        for (const issue of gateResult.issues) {
          this.logger.info('Quality gate issue', { severity: issue.severity, description: issue.description });
        }
      }
      // Quality gate enforcement: block output if decision is 'block'
      if (gateResult.decision === 'block') {
        this.logger.warn('Quality gate BLOCKED output', { outputType, score: gateResult.overallScore.toFixed(2) });
        // Replace output with a safe fallback
        currentResponse = `[Output withheld by quality gate — score ${gateResult.overallScore.toFixed(2)}, issues: ${gateResult.issues.map(i => i.description).join('; ')}]`;
        // Update the session message if already added
        const sess = this.engine.sessions.get(sessionId);
        const lastMsg = sess?.messages[sess.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content = currentResponse;
        }
      }
    }

    // 6. Auto-capture if configured
    if (this.config.autoCapture) {
      await this.autoCapture(userMessage, currentResponse);
    }

    // 6b. Record A/B test outcomes for active tests
    const activeTests = this.engine.improvement.abTesting.getActiveTests();
    if (activeTests.length > 0) {
      for (const test of activeTests) {
        try {
          const variant = this.engine.improvement.abTesting.getVariant(test.id, sessionId);
          if (variant) {
            // Score based on response quality heuristics
            const responseLength = currentResponse.length;
            const score = Math.min(1, Math.max(0, responseLength / 1000)); // Simple heuristic: longer = more complete
            this.engine.improvement.abTesting.recordResult(test.id, variant.id, {
              sessionId,
              variantId: variant.id,
              score,
              metadata: { rounds, toolCalls: toolCallsMade.length, responseLength },
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Don't block response on A/B test recording failure
          this.logger.debug('A/B test recording failed', { testId: test.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
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

    // 8b. Record token usage in cost tracker (if enabled)
    if (this.engine.costTracker) {
      try {
        const model = this.engine.llm.getDefault().getModelId();
        this.engine.costTracker.recordUsage(sessionId, {
          model,
          inputTokens: Math.ceil(userMessage.length / 4),
          outputTokens: totalTokens - Math.ceil(userMessage.length / 4),
        });
      } catch {
        // Best-effort — don't block on cost tracking
      }
    }

    // 9. Plugin Hook: afterResponse — allow plugins to observe the final response
    try {
      await this.engine.executePluginHook('afterResponse', sessionId, {
        response: currentResponse,
        toolCalls: toolCallsMade.length,
        totalTokens,
      });
    } catch (hookErr) {
      this.logger.warn('afterResponse hook failed', { error: hookErr instanceof Error ? hookErr.message : String(hookErr) });
    }

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

    // Append behavioral rules from safety system
    const behavioralRules = this.engine.safety.getRulesForPrompt();
    if (behavioralRules) {
      prompt += '\n\n' + behavioralRules;
    }

    // Append intent prediction for this user message
    const lastUserMsg = session.messages.filter(m => m.role === 'user').pop()?.content || '';
    if (lastUserMsg) {
      const intentBehavior = this.engine.safety.intentPredictor.getBehaviorForPrompt(lastUserMsg);
      if (intentBehavior) {
        prompt += '\n\n' + intentBehavior;
      }
    }

    // Append session state if available
    const state = await this.engine.memory.loadSessionState();
    if (state) {
      prompt += `\n\n## Resumed Session\n- Current task: ${state.currentTask}\n- Progress: ${state.progress}`;
      if (state.blockedBy) prompt += `\n- Blocked by: ${state.blockedBy}`;
      if (state.nextSteps.length > 0) prompt += `\n- Next steps: ${state.nextSteps.join(', ')}`;
    }

    // Append calibration insights (confidence adjustments from prediction verification)
    const calibrationInsights = this.engine.getCalibrationInsights();
    if (calibrationInsights.length > 0) {
      const insights = calibrationInsights.map(i => `- ${i.area}: ${i.message} (adjustment: ${i.adjustment > 0 ? '+' : ''}${i.adjustment})`).join('\n');
      prompt += `\n\n## Calibration Insights\nThe following confidence adjustments are active based on past prediction accuracy:\n${insights}`;
    }

    // Append drift corrections (identity reinforcement)
    const driftCorrections = this.engine.getDriftCorrections();
    if (driftCorrections.length > 0) {
      const corrections = driftCorrections.map(c => `- ${c.principleName}: ${c.correctionPrompt}`).join('\n');
      prompt += `\n\n## Identity Reinforcement\nRecent behavior has drifted from these principles. Please re-align:\n${corrections}`;
    }

    // Append A/B test variant (if active test exists for this session)
    const activeTests = this.engine.improvement.abTesting.getActiveTests();
    if (activeTests.length > 0) {
      for (const test of activeTests) {
        const variant = this.engine.improvement.abTesting.getVariant(test.id, sessionId);
        if (variant && variant.promptTemplate) {
          prompt += `\n\n## Experiment: ${test.name}\n${variant.promptTemplate}`;
        }
      }
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

  // ─── LLM Call (with retry) ─────────────────────────────────────────────

  private async callLLM(
    messages: ModelMessage[],
    streamHandler?: StreamHandler,
    sessionId?: string,
  ): Promise<LLMResponse> {
    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.callLLMInternal(messages, streamHandler, sessionId);
      } catch (err) {
        const isLastAttempt = attempt === maxRetries - 1;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Check if error is retryable (timeout, rate limit, network)
        const isRetryable = /timeout|rate.?limit|429|503|502|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(errorMsg);

        if (isLastAttempt || !isRetryable) {
          this.logger.error('LLM call failed', { attempt: attempt + 1, error: errorMsg, retryable: isRetryable });
          throw err;
        }

        const delayMs = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
        this.logger.warn('LLM call failed, retrying', { attempt: attempt + 1, error: errorMsg, retryInMs: delayMs });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error('LLM call failed after all retries');
  }

  private async callLLMInternal(
    messages: ModelMessage[],
    streamHandler?: StreamHandler,
    sessionId?: string,
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

    // Build AI SDK tools for LLM discovery (no execute — Lodestone handles execution with safety checks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK ToolSet requires flexible typing
    const aiTools: Record<string, any> = this.engine.tools.toAISDKTools();

    if (this.config.stream && streamHandler) {
      // Streaming mode
      const result = await streamText({
        model,
        system: systemPrompt,
        messages: chatMessages,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
      });

      let fullText = '';
      let toolCalls: ParsedToolCall[] = [];

      for await (const event of result.fullStream) {
        if (event.type === 'text-delta') {
          // AI SDK v6 uses event.text instead of event.textDelta
          const delta = (event as { text?: string; textDelta?: string }).text || (event as { textDelta?: string }).textDelta || '';
          fullText += delta;
          streamHandler.emit('text_delta', { text: delta });
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: (event as { args?: Record<string, unknown>; input?: Record<string, unknown> }).args || (event as { input?: Record<string, unknown> }).input as Record<string, unknown>,
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
        tokenCount: ((usage?.inputTokens || 0) + (usage?.outputTokens || 0)) || undefined,
      };
    } else {
      // Non-streaming mode
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: chatMessages,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
      });

      const toolCalls: ParsedToolCall[] = (result.toolCalls || []).map(tc => ({
        toolCallId: tc.toolCallId || `tc_${Date.now()}`,
        toolName: tc.toolName,
        arguments: typeof (tc as { args?: unknown }).args === 'string' ? JSON.parse((tc as { args?: string }).args!) : ((tc as { args?: Record<string, unknown> }).args || (tc as { input?: Record<string, unknown> }).input) as Record<string, unknown>,
      }));

      return {
        text: result.text,
        toolCalls,
        tokenCount: ((result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0)) || undefined,
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

    for (const tcOriginal of toolCalls) {
      let tc = tcOriginal;
      const startTime = Date.now();

      // Check capability tier — log warning if not auto-approved
      if (!this.engine.safety.canAutoApprove(tc.toolName)) {
        this.logger.warn('Tool requires confirmation but auto-approval not available — proceeding (log only)', { tool: tc.toolName });
      }

      // ─── Plugin Hook: beforeTool — allow plugins to modify params or block ──
      let pluginBlocked = false;
      try {
        const beforeHook = await this.engine.executePluginHook('beforeTool', sessionId, {
          toolId: tc.toolName,
          params: tc.arguments as Record<string, unknown>,
        });
        if (beforeHook.action === 'block') {
          const reason = beforeHook.blockReason ?? 'Blocked by plugin';
          results.push({
            toolId: tc.toolCallId,
            toolName: tc.toolName,
            success: false,
            data: null,
            summary: `Blocked by plugin: ${reason}`,
            error: reason,
            durationMs: Date.now() - startTime,
          });
          pluginBlocked = true;
        }
        // If modified, update the arguments for execution
        if (beforeHook.action === 'modify' && beforeHook.modifiedPayload) {
          const modified = beforeHook.modifiedPayload as { params?: Record<string, unknown> };
          if (modified.params) {
            tc = { ...tc, arguments: modified.params };
          }
        }
      } catch {
        // Plugin hooks are best-effort — never block the loop
      }
      if (pluginBlocked) continue;

      // Build tool context
      const toolLogger = getLogger(`Tool:${tc.toolName}`);
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
            await this.engine.memory.wiki.write(slug, content, frontmatter as Partial<WikiFrontmatter>);
          },
          wikiSearch: async (query: string, limit?: number) =>
            this.engine.memory.wiki.search(query, limit),
          scratchGet: async (key: string) =>
            this.engine.memory.scratch.scratchGet(key),
          scratchSet: async (key: string, value: string, ttlMs?: number) =>
            this.engine.memory.scratch.scratchSet(key, value, ttlMs),
        },
        log: {
          info: (msg: string, data?: unknown) => toolLogger.info(msg, { data }),
          warn: (msg: string, data?: unknown) => toolLogger.warn(msg, { data }),
          error: (msg: string, data?: unknown) => toolLogger.error(msg, { data }),
        },
        engine: this.engine,
      };

      // Execute the tool (with retry on transient failures)
      const maxToolRetries = 2;
      let result = await this.engine.tools.execute(tc.toolName, tc.arguments, context);
      for (let attempt = 1; attempt < maxToolRetries && !result.success; attempt++) {
        const isRetryable = /timeout|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(result.error || '');
        if (!isRetryable) break;

        const delayMs = 500 * Math.pow(2, attempt - 1); // 500ms, 1s
        this.logger.warn('Tool failed, retrying', { tool: tc.toolName, attempt, error: result.error, retryInMs: delayMs });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        result = await this.engine.tools.execute(tc.toolName, tc.arguments, context);
      }

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

      // Plugin Hook: afterTool — allow plugins to observe results
      try {
        await this.engine.executePluginHook('afterTool', sessionId, {
          toolName: tc.toolName,
          result,
          durationMs: Date.now() - startTime,
        });
      } catch (hookErr) {
        this.logger.warn('afterTool hook failed', { tool: tc.toolName, error: hookErr instanceof Error ? hookErr.message : String(hookErr) });
      }
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

    // Submit for memory promotion
    try {
      await this.engine.safety.memoryPromotion.submit(
        summary,
        `conversation:${Date.now()}`,
        'research',
        ['auto-capture', 'conversation']
      );
    } catch (err) {
      this.logger.warn('Memory promotion submit failed', { error: err });
    }
  }

  // ─── Output Type Detection ─────────────────────────────────────────

  /**
   * Detect the type of output for quality gating.
   * Simple heuristic: wiki links → wiki-write, email/at patterns → external-message, etc.
   */
  private detectOutputType(response: string): GateOutputType | null {
    // Wiki link syntax → wiki-write
    if (/\[\[.+?\]\]/.test(response)) {
      return 'wiki-write';
    }
    // Email patterns → external-message
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(response)) {
      return 'external-message';
    }
    // @-mention patterns → external-message
    if (/@[a-zA-Z0-9_]+/.test(response) && response.length < 500) {
      return 'external-message';
    }
    return null;
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