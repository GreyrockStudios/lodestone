/**
 * Lodestone Core — Streaming Response Handler
 *
 * Handles streaming LLM responses, tool calls, and partial content.
 * Designed for real-time UI updates and progressive tool execution.
 */

// ─── Stream Event Types ────────────────────────────────────────────────────

export type StreamEventType =
  | 'text_delta'      // Partial text content
  | 'tool_call_start' // Beginning of a tool call
  | 'tool_call_delta' // Partial tool call arguments
  | 'tool_call_end'   // Complete tool call, ready to execute
  | 'tool_result'     // Tool execution result
  | 'reasoning_delta' // Partial reasoning/thinking content
  | 'done'            // Stream complete
  | 'error';           // Stream error

export interface StreamEvent {
  type: StreamEventType;
  timestamp: string;
  data: unknown;
}

export interface TextDelta {
  text: string;
}

export interface ToolCallStart {
  toolCallId: string;
  toolName: string;
}

export interface ToolCallDelta {
  toolCallId: string;
  argumentsDelta: string;
}

export interface ToolCallEnd {
  toolCallId: string;
  toolName: string;
  arguments: string;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  success: boolean;
  result: string;
  durationMs: number;
}

export interface ReasoningDelta {
  text: string;
}

export interface StreamDone {
  totalTokens: number;
  finishReason: string;
}

export interface StreamError {
  error: string;
  recoverable: boolean;
}

// ─── Stream Handler ────────────────────────────────────────────────────────

export type StreamEventHandler = (event: StreamEvent) => void;

export interface StreamConfig {
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Whether to stream reasoning/thinking tokens */
  streamReasoning?: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export class StreamHandler {
  private handlers: Map<StreamEventType, Set<StreamEventHandler>> = new Map();
  private eventLog: StreamEvent[] = [];

  /** Register an event handler */
  on(eventType: StreamEventType, handler: StreamEventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  /** Remove an event handler */
  off(eventType: StreamEventType, handler: StreamEventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /** Emit a stream event to all registered handlers */
  emit(eventType: StreamEventType, data: unknown): void {
    const event: StreamEvent = {
      type: eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    this.eventLog.push(event);

    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`Stream handler error for ${eventType}:`, err);
        }
      }
    }
  }

  /** Get all events of a specific type */
  getEvents(type?: StreamEventType): StreamEvent[] {
    if (type) {
      return this.eventLog.filter(e => e.type === type);
    }
    return [...this.eventLog];
  }

  /** Get the complete text output */
  getTextContent(): string {
    return this.eventLog
      .filter(e => e.type === 'text_delta')
      .map(e => (e.data as TextDelta).text)
      .join('');
  }

  /** Get all tool calls */
  getToolCalls(): ToolCallEnd[] {
    return this.eventLog
      .filter(e => e.type === 'tool_call_end')
      .map(e => e.data as ToolCallEnd);
  }

  /** Get total tokens used */
  getTotalTokens(): number {
    const doneEvent = this.eventLog.find(e => e.type === 'done');
    return doneEvent ? (doneEvent.data as StreamDone).totalTokens : 0;
  }

  /** Clear event log */
  clear(): void {
    this.eventLog = [];
  }
}