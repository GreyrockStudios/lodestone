/**
 * Lodestone Tool — Calendar Integration
 *
 * Reads calendar events from CalDAV or Google Calendar API.
 * Supports: get schedule, get next event, create event, find free slot.
 * Uses built-in fetch for CalDAV — no extra dependencies.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { Logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  attendees?: string[];
  allDay?: boolean;
}

export interface TimeSlot {
  start: Date;
  end: Date;
  durationMin: number;
}

export interface CalendarConfig {
  /** Calendar provider */
  provider: 'caldav' | 'google';
  /** CalDAV: base URL of the calendar server */
  url?: string;
  /** CalDAV: calendar path (default: /calendars/user/calendar/) */
  calendarPath?: string;
  /** Auth token or password */
  token?: string;
  /** Username for basic auth (CalDAV) */
  username?: string;
  /** Google: OAuth2 access token */
  googleToken?: string;
  /** Google: calendar ID (default: primary) */
  calendarId?: string;
}

// ─── Calendar Tool ──────────────────────────────────────────────────────────

export class CalendarTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'calendar',
    name: 'Calendar',
    description: 'View and manage calendar events. Supports CalDAV and Google Calendar. Operations: get_schedule, get_next_event, create_event, find_free_slot.',
    parameters: [
      { name: 'operation', type: 'string', description: 'Operation: get_schedule, get_next_event, create_event, find_free_slot', required: true },
      { name: 'from', type: 'string', description: 'Start date/time (ISO 8601). Required for get_schedule, find_free_slot', required: false },
      { name: 'to', type: 'string', description: 'End date/time (ISO 8601). Required for get_schedule, find_free_slot', required: false },
      { name: 'title', type: 'string', description: 'Event title (for create_event)', required: false },
      { name: 'start', type: 'string', description: 'Event start time (ISO 8601, for create_event)', required: false },
      { name: 'end', type: 'string', description: 'Event end time (ISO 8601, for create_event)', required: false },
      { name: 'durationMin', type: 'number', description: 'Duration in minutes (for find_free_slot)', required: false },
      { name: 'location', type: 'string', description: 'Event location (for create_event)', required: false },
      { name: 'description', type: 'string', description: 'Event description (for create_event)', required: false },
    ],
    sideEffects: true,
    requiresApproval: false,
    timeout: 15000,
  };

  private config: CalendarConfig;
  private log: Logger;

  constructor(config: CalendarConfig) {
    this.config = config;
    this.log = new Logger({ minLevel: 'info' });
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const operation = params.operation as string;
    const start = Date.now();

    try {
      switch (operation) {
        case 'get_schedule':
          return await this.getSchedule(params, start);
        case 'get_next_event':
          return await this.handleGetNextEvent(params, start);
        case 'create_event':
          return await this.handleCreateEvent(params, start);
        case 'find_free_slot':
          return await this.findFreeSlot(params, start);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown operation: ${operation}`,
            error: `Valid operations: get_schedule, get_next_event, create_event, find_free_slot`,
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Calendar operation failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Public API (for direct use by engine) ───────────────────────────────

  /**
   * Get events in a date range.
   */
  async getEvents(opts: { from: Date; to: Date }): Promise<CalendarEvent[]> {
    if (this.config.provider === 'caldav') {
      return this.getCaldavEvents(opts.from, opts.to);
    } else {
      return this.getGoogleEvents(opts.from, opts.to);
    }
  }

  /**
   * Get today's events.
   */
  async getToday(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return this.getEvents({ from: startOfDay, to: endOfDay });
  }

  /**
   * Get the next upcoming event.
   */
  async getNextEvent(): Promise<CalendarEvent | null> {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Next 7 days
    const events = await this.getEvents({ from: now, to: end });
    if (events.length === 0) return null;
    return events[0];
  }

  /**
   * Create a new calendar event.
   */
  async createEvent(event: CalendarEvent): Promise<void> {
    if (this.config.provider === 'caldav') {
      await this.createCaldavEvent(event);
    } else {
      await this.createGoogleEvent(event);
    }
  }

  /**
   * Find a free time slot of the given duration.
   */
  async findSlot(durationMin: number, from: Date, to: Date): Promise<TimeSlot | null> {
    const events = await this.getEvents({ from, to });
    // Sort by start time
    events.sort((a, b) => a.start.getTime() - b.start.getTime());

    const durationMs = durationMin * 60 * 1000;

    // Check gap before first event
    if (events.length === 0) {
      // Entire range is free
      if (to.getTime() - from.getTime() >= durationMs) {
        return { start: from, end: new Date(from.getTime() + durationMs), durationMin };
      }
      return null;
    }

    // Check before first event
    const firstStart = events[0].start.getTime();
    if (firstStart - from.getTime() >= durationMs) {
      return { start: from, end: new Date(from.getTime() + durationMs), durationMin };
    }

    // Check between events
    for (let i = 0; i < events.length - 1; i++) {
      const gapStart = events[i].end.getTime();
      const gapEnd = events[i + 1].start.getTime();
      if (gapEnd - gapStart >= durationMs) {
        return { start: new Date(gapStart), end: new Date(gapStart + durationMs), durationMin };
      }
    }

    // Check after last event
    const lastEnd = events[events.length - 1].end.getTime();
    if (to.getTime() - lastEnd >= durationMs) {
      return { start: new Date(lastEnd), end: new Date(lastEnd + durationMs), durationMin };
    }

    return null;
  }

  // ─── Tool Execution Wrappers ─────────────────────────────────────────────

  private async getSchedule(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const fromStr = params.from as string;
    const toStr = params.to as string;
    if (!fromStr || !toStr) {
      return {
        success: false, data: null,
        summary: 'Missing required parameters: from and to',
        error: 'Both "from" and "to" are required for get_schedule',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const from = new Date(fromStr);
    const to = new Date(toStr);
    const events = await this.getEvents({ from, to });

    return {
      success: true,
      data: { events, count: events.length },
      summary: `Found ${events.length} event(s) from ${from.toISOString()} to ${to.toISOString()}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async handleGetNextEvent(_params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const next = await this.getNextEvent();

    if (!next) {
      return {
        success: true,
        data: { event: null },
        summary: 'No upcoming events in the next 7 days',
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    return {
      success: true,
      data: { event: next },
      summary: `Next event: "${next.title}" at ${next.start.toISOString()}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async handleCreateEvent(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const title = params.title as string;
    const startStr = params.start as string;
    const endStr = params.end as string;

    if (!title || !startStr || !endStr) {
      return {
        success: false, data: null,
        summary: 'Missing required parameters: title, start, end',
        error: 'title, start, and end are required for create_event',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const event: CalendarEvent = {
      id: `evt-${Date.now()}`,
      title,
      start: new Date(startStr),
      end: new Date(endStr),
      location: params.location as string | undefined,
      description: params.description as string | undefined,
    };

    await this.createEvent(event);

    return {
      success: true,
      data: { event },
      summary: `Created event: "${title}" on ${startStr}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async findFreeSlot(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const durationMin = params.durationMin as number;
    const fromStr = params.from as string;
    const toStr = params.to as string;

    if (!durationMin || !fromStr || !toStr) {
      return {
        success: false, data: null,
        summary: 'Missing required parameters: durationMin, from, to',
        error: 'durationMin, from, and to are required for find_free_slot',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const slot = await this.findSlot(durationMin, new Date(fromStr), new Date(toStr));

    if (!slot) {
      return {
        success: true,
        data: { slot: null },
        summary: `No free ${durationMin}min slot found between ${fromStr} and ${toStr}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    return {
      success: true,
      data: { slot },
      summary: `Found free slot: ${slot.start.toISOString()} → ${slot.end.toISOString()} (${durationMin}min)`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  // ─── CalDAV Implementation ───────────────────────────────────────────────

  private async getCaldavEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const url = this.config.url;
    if (!url) throw new Error('CalDAV url not configured');

    const calendarPath = this.config.calendarPath || '/calendars/user/calendar/';
    const fullUrl = url.replace(/\/$/, '') + calendarPath;

    // CalDAV REPORT request for events in time range
    const timeRange = `
      <C:time-range start="${this.toCalDavDate(from)}" end="${this.toCalDavDate(to)}"/>
    `;

    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop xmlns:D="DAV:">
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        ${timeRange}
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/xml; charset=utf-8',
      'Depth': '1',
    };

    // Auth
    if (this.config.username && this.config.token) {
      const credentials = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const response = await fetch(fullUrl, {
      method: 'REPORT',
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`CalDAV REPORT failed: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();
    return this.parseCaldavEvents(xmlText);
  }

  private async createCaldavEvent(event: CalendarEvent): Promise<void> {
    const url = this.config.url;
    if (!url) throw new Error('CalDAV url not configured');

    const calendarPath = this.config.calendarPath || '/calendars/user/calendar/';
    const eventUrl = url.replace(/\/$/, '') + calendarPath + event.id + '.ics';

    const ics = this.eventToIcs(event);

    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    };

    if (this.config.username && this.config.token) {
      const credentials = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const response = await fetch(eventUrl, {
      method: 'PUT',
      headers,
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
    }

    this.log.info(`[Calendar] Created CalDAV event: ${event.title} (${event.id})`);
  }

  private parseCaldavEvents(xml: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    // Simple regex-based VEVENT extraction (avoids needing an XML parser)
    const veventRegex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
    const matches = xml.match(veventRegex) || [];

    for (const vevent of matches) {
      const event = this.parseIcs(vevent);
      if (event) events.push(event);
    }

    return events;
  }

  private parseIcs(ics: string): CalendarEvent | null {
    try {
      const getProp = (key: string): string | null => {
        const match = ics.match(new RegExp(`^${key}[^:]*:(.*)$`, 'm'));
        return match ? match[1].trim() : null;
      };

      const uid = getProp('UID') || `evt-${Date.now()}`;
      const summary = getProp('SUMMARY') || '(no title)';
      const dtStart = getProp('DTSTART') || getProp('DTSTART;VALUE=DATE');
      const dtEnd = getProp('DTEND') || getProp('DTEND;VALUE=DATE');
      const location = getProp('LOCATION') || undefined;
      const description = getProp('DESCRIPTION') || undefined;

      if (!dtStart) return null;

      const start = this.parseIcsDate(dtStart);
      const end = dtEnd ? this.parseIcsDate(dtEnd) : new Date(start.getTime() + 60 * 60 * 1000);
      const allDay = dtStart.length === 8; // YYYYMMDD = all-day

      return {
        id: uid,
        title: summary,
        start,
        end,
        location,
        description,
        allDay,
      };
    } catch {
      return null;
    }
  }

  private parseIcsDate(dateStr: string): Date {
    // Handle YYYYMMDDTHHMMSSZ and YYYYMMDD formats
    if (dateStr.includes('T')) {
      // Date-time
      const clean = dateStr.replace(/^(TZID=.*?:)?/, '').replace(/Z$/, '');
      const year = parseInt(clean.slice(0, 4));
      const month = parseInt(clean.slice(4, 6)) - 1;
      const day = parseInt(clean.slice(6, 8));
      const hour = parseInt(clean.slice(9, 11)) || 0;
      const min = parseInt(clean.slice(11, 13)) || 0;
      const sec = parseInt(clean.slice(13, 15)) || 0;
      return new Date(Date.UTC(year, month, day, hour, min, sec));
    } else {
      // All-day date: YYYYMMDD
      const year = parseInt(dateStr.slice(0, 4));
      const month = parseInt(dateStr.slice(4, 6)) - 1;
      const day = parseInt(dateStr.slice(6, 8));
      return new Date(Date.UTC(year, month, day));
    }
  }

  private toCalDavDate(date: Date): string {
    // Format: YYYYMMDDTHHMMSSZ
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      date.getUTCFullYear().toString() +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      'T' +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      'Z'
    );
  }

  private eventToIcs(event: CalendarEvent): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const fmtDate = (d: Date) =>
      d.getUTCFullYear().toString() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      'Z';

    const now = new Date();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Lodestone//Calendar//EN',
      'BEGIN:VEVENT',
      `UID:${event.id}`,
      `DTSTAMP:${fmtDate(now)}`,
      `DTSTART:${fmtDate(event.start)}`,
      `DTEND:${fmtDate(event.end)}`,
      `SUMMARY:${event.title}`,
    ];

    if (event.location) lines.push(`LOCATION:${event.location}`);
    if (event.description) lines.push(`DESCRIPTION:${event.description}`);

    lines.push('END:VEVENT', 'END:VCALENDAR');

    return lines.join('\r\n');
  }

  // ─── Google Calendar Implementation ─────────────────────────────────────

  private async getGoogleEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const token = this.config.googleToken;
    if (!token) throw new Error('Google OAuth token not configured');

    const calendarId = this.config.calendarId || 'primary';
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('timeMin', from.toISOString());
    url.searchParams.set('timeMax', to.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { items?: Array<Record<string, unknown>> };
    return (data.items || []).map((item: Record<string, unknown>) => this.parseGoogleEvent(item));
  }

  private async createGoogleEvent(event: CalendarEvent): Promise<void> {
    const token = this.config.googleToken;
    if (!token) throw new Error('Google OAuth token not configured');

    const calendarId = this.config.calendarId || 'primary';
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    const body = {
      id: event.id,
      summary: event.title,
      start: { dateTime: event.start.toISOString() },
      end: { dateTime: event.end.toISOString() },
      location: event.location,
      description: event.description,
      attendees: (event.attendees || []).map(email => ({ email })),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Google Calendar create failed: ${response.status} ${response.statusText}`);
    }

    this.log.info(`[Calendar] Created Google event: ${event.title} (${event.id})`);
  }

  private parseGoogleEvent(item: Record<string, unknown>): CalendarEvent {
    const startRaw = item.start as Record<string, unknown> | undefined;
    const endRaw = item.end as Record<string, unknown> | undefined;
    const start = startRaw?.dateTime ? new Date(startRaw.dateTime as string) :
                  startRaw?.date ? new Date(startRaw.date as string) : new Date();
    const end = endRaw?.dateTime ? new Date(endRaw.dateTime as string) :
                endRaw?.date ? new Date(endRaw.date as string) : new Date(start.getTime() + 60 * 60 * 1000);

    return {
      id: item.id as string,
      title: (item.summary as string | undefined) || '(no title)',
      start,
      end,
      location: item.location as string | undefined,
      description: item.description as string | undefined,
      attendees: ((item.attendees as Array<{ email?: string }> | undefined) || []).map((a: { email?: string }) => a.email).filter((e: string | undefined): e is string => e !== undefined),
      allDay: !startRaw?.dateTime,
    };
  }
}