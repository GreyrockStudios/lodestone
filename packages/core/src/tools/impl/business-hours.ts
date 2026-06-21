/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Business Hours Tool
 *
 * Checks if it's currently business hours. Useful for deciding whether
 * to send non-urgent messages or hold them until business hours.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const definition: ToolDefinition = {
  id: 'business-hours',
  name: 'Business Hours',
  description: 'Check if it is currently business hours. Use before sending non-urgent messages.',
  parameters: [
    { name: 'action', description: 'check, config, should_send', type: 'string', required: true },
    { name: 'timezone', description: 'IANA timezone (e.g. America/Toronto)', type: 'string', required: false },
    { name: 'startHour', description: 'Business hours start (0-23)', type: 'number', required: false },
    { name: 'endHour', description: 'Business hours end (0-23)', type: 'number', required: false },
    { name: 'weekdays', description: 'Business days (1=Mon, 7=Sun)', type: 'array', required: false, items: { name: 'day', description: 'Day number', type: 'number', required: false } },
    { name: 'message', description: 'Message content to evaluate for urgency', type: 'string', required: false },
    { name: 'urgentKeywords', description: 'Keywords that override off-hours hold', type: 'array', required: false, items: { name: 'keyword', description: 'A keyword', type: 'string', required: false } },
  ],
  sideEffects: false,
  requiresApproval: false,
};

export interface BusinessHoursConfig {
  timezone: string;
  startHour: number;
  endHour: number;
  weekdays: number[];
  holdMessages: boolean;
  urgentKeywords: string[];
}

export class BusinessHoursTool implements Tool {
  readonly definition = definition;
  private config: BusinessHoursConfig;

  constructor(config?: Partial<BusinessHoursConfig>) {
    this.config = {
      timezone: 'America/Toronto',
      startHour: 9,
      endHour: 18,
      weekdays: [1, 2, 3, 4, 5], // Mon-Fri
      holdMessages: true,
      urgentKeywords: ['urgent', 'emergency', 'critical', 'down', 'outage', 'security'],
      ...config,
    };
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    switch (action) {
      case 'check':
        return this.check();
      case 'config':
        return this.configAction(params);
      case 'should_send':
        return this.shouldSend(params);
      default:
        return {
          success: false, data: null,
          summary: `Unknown action: ${action}`,
          error: 'Valid actions: check, config, should_send',
          durationMs: Date.now() - start,
          includeInContext: true,
        };
    }
  }

  private check(): ToolResult {
    const now = new Date();
    const tz = this.config.timezone;

    // Get current hour and day in the configured timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const weekdayStr = weekdayFormatter.format(now);
    const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const weekday = weekdayMap[weekdayStr] || 1;

    const isBusinessDay = this.config.weekdays.includes(weekday);
    const isBusinessHour = hour >= this.config.startHour && hour < this.config.endHour;
    const isBusinessHours = isBusinessDay && isBusinessHour;

    return {
      success: true,
      data: {
        isBusinessHours,
        currentTime: now.toISOString(),
        timezone: tz,
        currentHour: hour,
        currentDay: weekday,
        businessHours: `${this.config.startHour}:00-${this.config.endHour}:00`,
        businessDays: this.config.weekdays,
      },
      summary: isBusinessHours ? '✅ Currently business hours' : '❌ Outside business hours',
      durationMs: 0,
      includeInContext: true,
    };
  }

  private configAction(params: Record<string, unknown>): ToolResult {
    if (params.timezone) this.config.timezone = params.timezone as string;
    if (params.startHour !== undefined) this.config.startHour = params.startHour as number;
    if (params.endHour !== undefined) this.config.endHour = params.endHour as number;
    if (params.weekdays) this.config.weekdays = params.weekdays as number[];
    if (params.urgentKeywords) this.config.urgentKeywords = params.urgentKeywords as string[];

    return {
      success: true,
      data: this.config,
      summary: 'Business hours config updated',
      durationMs: 0,
      includeInContext: true,
    };
  }

  private shouldSend(params: Record<string, unknown>): ToolResult {
    const message = (params.message as string) || '';
    const check = this.check();
    const isBusinessHours = (check.data as Record<string, unknown>)?.isBusinessHours as boolean;

    // Check for urgent keywords
    const lowerMessage = message.toLowerCase();
    const isUrgent = this.config.urgentKeywords.some(kw => lowerMessage.includes(kw.toLowerCase()));

    const shouldSend = isBusinessHours || isUrgent || !this.config.holdMessages;

    return {
      success: true,
      data: {
        shouldSend,
        isBusinessHours,
        isUrgent,
        reason: shouldSend
          ? (isUrgent ? 'Urgent keyword detected' : 'Business hours')
          : 'Outside business hours — hold until next business hours',
      },
      summary: shouldSend ? '✅ Send now' : '⏸️ Hold until business hours',
      durationMs: 0,
      includeInContext: true,
    };
  }
}