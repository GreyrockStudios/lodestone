/**
 * Lodestone Core — Identity Loader
 *
 * Loads and validates the agent's identity files:
 * SOUL.md, IDENTITY.md, USER.md, RULES.md, HEARTBEAT.md
 *
 * These files define WHO the agent is, HOW it behaves,
 * and WHAT it should focus on.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Identity Types ─────────────────────────────────────────────────────────

export interface AgentIdentity {
  name: string;
  emoji?: string;
  creature?: string;
  description?: string;
  firstOnline?: string;
  namedBy?: string;
  vibe?: string;
}

export interface UserIdentity {
  name: string;
  role?: string;
  contact?: Record<string, string>;
  preferences?: Record<string, unknown>;
}

export interface AgentRules {
  raw: string;
  parsed?: {
    directivePrecedence?: string[];
    autonomyModes?: string[];
    communicationRules?: string[];
    redLines?: string[];
    securityRules?: string[];
  };
}

export interface HeartbeatState {
  activeProjects: string[];
  learningQueue?: string[];
  healthChecks?: Record<string, string>;
  rules?: string[];
  raw: string;
}

export interface Identity {
  /** Who the agent is */
  identity: AgentIdentity;
  /** The agent's personality and tone */
  soul: string;
  /** Who the agent serves */
  user: UserIdentity;
  /** How the agent operates */
  rules: AgentRules;
  /** What the agent is currently working on */
  heartbeat: HeartbeatState;
  /** The combined system prompt */
  systemPrompt: string;
}

// ─── Identity Loader ────────────────────────────────────────────────────────

export interface IdentityConfig {
  /** Root directory containing identity files */
  identityDir: string;
  /** Which files to load (default: all) */
  load?: ('identity' | 'soul' | 'user' | 'rules' | 'heartbeat')[];
  /** Whether to validate required files */
  validate?: boolean;
}

const REQUIRED_FILES = ['IDENTITY.md', 'SOUL.md'] as const;
const OPTIONAL_FILES = ['USER.md', 'RULES.md', 'HEARTBEAT.md'] as const;

export class IdentityLoader {
  private config: IdentityConfig;

  constructor(config: IdentityConfig) {
    this.config = {
      validate: true,
      load: ['identity', 'soul', 'user', 'rules', 'heartbeat'],
      ...config,
    };
  }

  /** Load all identity files and return the complete identity */
  async load(): Promise<Identity> {
    const identity = await this.loadIdentity();
    const soul = await this.loadSoul();
    const user = await this.loadUser();
    const rules = await this.loadRules();
    const heartbeat = await this.loadHeartbeat();

    const systemPrompt = this.buildSystemPrompt(identity, soul, user, rules, heartbeat);

    return { identity, soul, user, rules, heartbeat, systemPrompt };
  }

  private async readFile(filename: string): Promise<string | null> {
    try {
      const content = await readFile(join(this.config.identityDir, filename), 'utf-8');
      return content.trim();
    } catch {
      return null;
    }
  }

  private async requireFile(filename: string): Promise<string> {
    const content = await this.readFile(filename);
    if (content === null) {
      throw new Error(
        `Required identity file not found: ${join(this.config.identityDir, filename)}. ` +
        `Run 'lodestone init' to create identity files.`
      );
    }
    return content;
  }

  private async loadIdentity(): Promise<AgentIdentity> {
    const content = await this.requireFile('IDENTITY.md');
    return this.parseIdentityMd(content);
  }

  private async loadSoul(): Promise<string> {
    const content = await this.requireFile('SOUL.md');
    return content;
  }

  private async loadUser(): Promise<UserIdentity> {
    const content = await this.readFile('USER.md');
    if (!content) {
      return { name: 'User' };
    }
    return this.parseUserMd(content);
  }

  private async loadRules(): Promise<AgentRules> {
    const content = await this.readFile('RULES.md');
    if (!content) {
      return { raw: '' };
    }
    return { raw: content, parsed: this.parseRulesMd(content) };
  }

  private async loadHeartbeat(): Promise<HeartbeatState> {
    const content = await this.readFile('HEARTBEAT.md');
    if (!content) {
      return { activeProjects: [], raw: '' };
    }
    return this.parseHeartbeatMd(content);
  }

  private parseIdentityMd(content: string): AgentIdentity {
    const identity: AgentIdentity = { name: 'Agent' };

    // Parse key: value pairs from markdown (handles both **Name:** and **Name**\:)
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s*\*\*([^*]+)\*\*:?\s*(.+)/);
      if (match) {
        const [, key, value] = match;
        const cleanKey = key.replace(/:$/, '').trim().toLowerCase();
        const cleanValue = value.replace(/\*+/g, '').trim();
        switch (cleanKey) {
          case 'name': identity.name = cleanValue; break;
          case 'emoji': identity.emoji = cleanValue; break;
          case 'creature': identity.creature = cleanValue; break;
          case 'vibe': identity.vibe = cleanValue; break;
        }
      }
    }

    // Try to find name from heading
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch && !identity.name.includes('Agent')) {
      identity.name = headingMatch[1].replace(/[^a-zA-Z\s]/g, '').trim();
    }

    return identity;
  }

  private parseUserMd(content: string): UserIdentity {
    const user: UserIdentity = { name: 'User' };

    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s*\*\*(\w+)\*[*]:\s*(.+)/);
      if (match) {
        const [, key, value] = match;
        const cleanValue = value.replace(/\*+/g, '').trim();
        if (key.toLowerCase() === 'name') {
          user.name = cleanValue;
        }
      }
    }

    return user;
  }

  private parseRulesMd(content: string): AgentRules['parsed'] {
    // Simple heuristic parsing — sections are headings, items are bullets
    const sections: Record<string, string[]> = {};
    let currentSection = '';

    for (const line of content.split('\n')) {
      const heading = line.match(/^#+\s+(.+)/);
      if (heading) {
        currentSection = heading[1].toLowerCase().trim();
        sections[currentSection] = [];
      } else if (currentSection && line.trim().startsWith('-')) {
        sections[currentSection]?.push(line.trim().replace(/^[-*]\s*/, ''));
      }
    }

    return {
      directivePrecedence: sections['directive precedence'] || sections['precedence'],
      autonomyModes: sections['autonomy'] || sections['autonomy posture'],
      communicationRules: sections['communication'],
      redLines: sections['red lines'] || sections['redlines'],
      securityRules: sections['security'],
    };
  }

  private parseHeartbeatMd(content: string): HeartbeatState {
    const activeProjects: string[] = [];
    let raw = content;

    // Extract project lines under "Active" section
    const lines = content.split('\n');
    let inActive = false;
    for (const line of lines) {
      if (line.match(/^##\s+Active/i)) {
        inActive = true;
      } else if (line.match(/^##\s+/)) {
        inActive = false;
      } else if (inActive && line.trim().startsWith('- **')) {
        const project = line.replace(/^- \*\*/, '').replace(/\*\*.*/, '').trim();
        if (project) activeProjects.push(project);
      }
    }

    return { activeProjects, raw };
  }

  private buildSystemPrompt(
    identity: AgentIdentity,
    soul: string,
    user: UserIdentity,
    rules: AgentRules,
    heartbeat: HeartbeatState
  ): string {
    const parts: string[] = [];

    // Identity header
    parts.push(`# ${identity.name}${identity.emoji ? ' ' + identity.emoji : ''}`);
    if (identity.creature) parts.push(`You are ${identity.creature}.`);
    if (identity.vibe) parts.push(`${identity.vibe}`);
    parts.push('');

    // Soul
    if (soul) {
      parts.push('## Personality & Tone');
      parts.push(soul);
      parts.push('');
    }

    // User context
    parts.push(`## User: ${user.name}`);
    if (user.role) parts.push(`Role: ${user.role}`);
    parts.push('');

    // Rules
    if (rules.raw) {
      parts.push('## Operating Rules');
      parts.push(rules.raw);
      parts.push('');
    }

    // Heartbeat (current focus)
    if (heartbeat.raw) {
      parts.push('## Current Focus');
      parts.push(heartbeat.raw);
      parts.push('');
    }

    return parts.join('\n');
  }
}