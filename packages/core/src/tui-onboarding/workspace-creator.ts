/**
 * Lodestone — Workspace Creator
 *
 * Shared module for creating a Lodestone workspace from onboarding answers.
 * Used by both the TUI onboarding flow and the headless CLI init.
 *
 * Creates:
 * - Directory tree (wiki, agents, data, inbox)
 * - Identity files from templates (SOUL.md, IDENTITY.md, USER.md, RULES.md, HEARTBEAT.md)
 * - lodestone.config.yaml (with chosen LLM provider/model)
 * - .env (with API key placeholders)
 * - .gitignore
 * - Wiki index
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../../../templates');

// ─── Template metadata ─────────────────────────────────────────────────────

export const TEMPLATE_INFO: Record<string, { emoji: string; name: string; desc: string; soul: string; defaultName: string }> = {
  general: {
    emoji: '🔮',
    name: 'General',
    desc: 'A balanced assistant for everyday tasks. Adaptable, helpful, grounded.',
    soul: "I'm {name}. Helpful, adaptable, and grounded. I get things done without overcomplicating.",
    defaultName: 'Lodestone',
  },
  developer: {
    emoji: '💻',
    name: 'Developer',
    desc: 'A coding partner focused on software. Thinks in systems, debugs methodically.',
    soul: "I'm {name}. I write clean code, catch bugs before they bite, and think in systems. No fluff — just working software.",
    defaultName: 'Coder',
  },
  business: {
    emoji: '📊',
    name: 'Business',
    desc: 'A strategic advisor for business decisions. Data-driven, concise, revenue-focused.',
    soul: "I'm {name}. Strategic, data-driven, and focused on what moves the needle. I cut through noise to find leverage.",
    defaultName: 'Atlas',
  },
  creative: {
    emoji: '🎨',
    name: 'Creative',
    desc: 'A creative collaborator for writing, design, and ideas. Imaginative, expressive.',
    soul: "I'm {name}. I think in stories, see patterns others miss, and craft things that resonate. Let's make something worth making.",
    defaultName: 'Muse',
  },
  researcher: {
    emoji: '🔬',
    name: 'Researcher',
    desc: 'A research assistant for analysis and synthesis. Thorough, evidence-based, precise.',
    soul: "I'm {name}. I follow the evidence, question assumptions, and synthesize across domains. Rigor and curiosity.",
    defaultName: 'Scholar',
  },
};

export const PROVIDER_INFO: Record<string, { emoji: string; name: string; models: string[]; desc: string }> = {
  ollama: { emoji: '🦙', name: 'Ollama (local)', models: ['glm-5.1:cloud', 'qwen3:8b', 'llama3:8b', 'mistral:7b'], desc: 'Run models on your own machine. Free, private, no API key needed.' },
  openai: { emoji: '🟢', name: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'], desc: 'Cloud API. Requires OPENAI_API_KEY in environment.' },
  anthropic: { emoji: '🟣', name: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514'], desc: 'Cloud API. Requires ANTHROPIC_API_KEY in environment.' },
};

export const PERSONALITY_INFO: Record<string, { emoji: string; name: string; desc: string }> = {
  concise: { emoji: '⚡', name: 'Concise', desc: 'Short, direct answers. No filler. Get to the point.' },
  balanced: { emoji: '⚖️', name: 'Balanced', desc: 'Thoughtful but efficient. Enough detail to be useful, not so much it drowns.' },
  detailed: { emoji: '📖', name: 'Detailed', desc: 'Thorough explanations with context. I\'d rather over-explain than under-explain.' },
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkspaceConfig {
  agentName: string;
  userName: string;
  template: string;
  templates?: string[];  // Multiple templates — first is primary, others blend in
  personality: 'concise' | 'balanced' | 'detailed';
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  workspacePath: string;
}

// ─── Workspace creation ────────────────────────────────────────────────────

export function createWorkspaceFromAnswers(config: WorkspaceConfig): void {
  const root = config.workspacePath;
  const templateInfo = TEMPLATE_INFO[config.template];

  // Create directory tree
  const dirs = [
    root,
    join(root, 'memory'),
    join(root, 'memory', 'wiki'),
    join(root, 'memory', 'wiki', 'entities'),
    join(root, 'memory', 'wiki', 'concepts'),
    join(root, 'memory', 'wiki', 'decisions'),
    join(root, 'memory', 'wiki', 'projects'),
    join(root, 'memory', 'wiki', 'areas'),
    join(root, 'memory', 'wiki', 'research'),
    join(root, 'memory', 'agents'),
    join(root, 'memory', 'agents', config.agentName.toLowerCase().replace(/\s+/g, '-')),
    join(root, 'memory', '00-inbox'),
    join(root, 'data'),
    join(root, 'data', 'lancedb'),
    join(root, 'data', 'logs'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy template files, replacing placeholders
  const allTemplates = config.templates || [config.template];
  const primaryTemplate = allTemplates[0];
  const templateDir = join(TEMPLATES_DIR, primaryTemplate);
  const today = new Date().toISOString().split('T')[0];

  if (existsSync(templateDir)) {
    const files = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'RULES.md', 'HEARTBEAT.md'];
    for (const file of files) {
      const src = join(templateDir, file);
      if (existsSync(src)) {
        let content = readFileSync(src, 'utf-8');
        content = content.replace(/\{\{name\}\}/g, config.agentName);
        content = content.replace(/\{\{userName\}\}/g, config.userName);
        content = content.replace(/\{\{date\}\}/g, today);
        // Inject personality into SOUL.md
        if (file === 'SOUL.md') {
          const personalityDirective = config.personality === 'concise'
            ? '\n\nBe concise. Short answers. No filler. Get to the point.'
            : config.personality === 'detailed'
            ? '\n\nBe thorough. Provide full context and explanations. Over-explain rather than under-explain.'
            : '\n\nBe balanced. Enough detail to be useful, not so much it drowns.';
          content = content.replace(/\{\{name\}\}/g, config.agentName) + personalityDirective;
        }
        writeFileSync(join(root, file), content);
      }
    }
  }

  // Blend in additional templates (secondary focus areas)
  for (let i = 1; i < allTemplates.length; i++) {
    const secondaryKey = allTemplates[i];
    const secondaryDir = join(TEMPLATES_DIR, secondaryKey);
    if (existsSync(secondaryDir)) {
      const secondarySoul = join(secondaryDir, 'SOUL.md');
      if (existsSync(secondarySoul)) {
        let soulContent = readFileSync(secondarySoul, 'utf-8');
        soulContent = soulContent.replace(/\{\{name\}\}/g, config.agentName);
        soulContent = soulContent.replace(/\{\{userName\}\}/g, config.userName);
        const secondaryName = TEMPLATE_INFO[secondaryKey]?.name || secondaryKey;
        const existingSoul = readFileSync(join(root, 'SOUL.md'), 'utf-8');
        writeFileSync(join(root, 'SOUL.md'), existingSoul + `\n\n## ${secondaryName} Focus\n\n${soulContent}`);
      }
    }
  }

  // Generate config (written to project root, one level up from workspace identity)
  const projectRoot = dirname(root);
  writeFileSync(join(projectRoot, 'lodestone.config.yaml'), generateConfig(config));

  // Generate wiki index
  writeFileSync(join(root, 'memory', 'wiki', 'index.md'), generateWikiIndex(config));

  // Generate .env (at project root)
  writeFileSync(join(projectRoot, '.env'), generateEnvFile(config));

  // Generate .gitignore (at project root)
  writeFileSync(join(projectRoot, '.gitignore'), generateGitignore());
}

// ─── Generators ────────────────────────────────────────────────────────────

function generateConfig(state: WorkspaceConfig): string {
  const provider = state.provider;
  const model = state.model;

  const providerBlock = provider === 'ollama'
    ? `    type: ollama\n    model: ${model}\n    baseUrl: http://127.0.0.1:11434/api`
    : provider === 'openai'
    ? `    type: openai\n    model: ${model}\n    apiKey: \${OPENAI_API_KEY}`
    : `    type: anthropic\n    model: ${model}\n    apiKey: \${ANTHROPIC_API_KEY}`;

  return `# Lodestone Configuration
# Generated by lodestone init
# See https://github.com/greyrockstudios/lodestone for full docs
#
# Edit this file to customize your agent.
# Settings here are persistent — they survive restarts.
# The model and provider you chose during setup are saved here.

llm:
  default:
${providerBlock}
    contextWindow: 128000
    maxTokens: 8192

channels:
  # Telegram bot (set LODESTONE_TELEGRAM_TOKEN to enable)
  # telegram:
  #   enabled: false
  #   botToken: \${TELEGRAM_BOT_TOKEN}

  # Discord bot (set LODESTONE_DISCORD_TOKEN to enable)
  # discord:
  #   enabled: false
  #   botToken: \${DISCORD_BOT_TOKEN}

  # Web chat (enable for browser-based chat)
  # webchat:
  #   enabled: false
  #   port: 3000

memory:
  vectorDb:
    provider: lancedb
    path: ./workspace/data/lancedb
    embedding:
      provider: ollama
      model: nomic-embed-text
      dimensions: 768
    autoRecall: true
    autoCapture: false

  wiki:
    path: ./workspace/memory/wiki
    autoLint: true
    autoIndex: true

  scratch:
    path: ./workspace/data/scratch.db

identity:
  dir: ./workspace

session:
  compactionThreshold: 0.5
  keepRecentCount: 10
  maxEntries: 200
  pruneAfter: 7d

proactive:
  sensorium:
    enabled: true
    interval: 30m
  sleep:
    enabled: true
    schedule: "0 3 * * *"
    timezone: "America/Toronto"
  drift:
    enabled: true
    schedule: "0 9 * * 1"

scheduler:
  maxConcurrent: 4

logging:
  level: info
  file: ./workspace/data/logs/lodestone.log
`;
}

function generateWikiIndex(state: WorkspaceConfig): string {
  const today = new Date().toISOString().split('T')[0];
  return `---
title: Knowledge Index
created: ${today}
updated: ${today}
status: active
tags: [index]
---

# Knowledge Index

Welcome to ${state.agentName}'s knowledge base. Pages are organized by category:

## Categories

- [[entities/]] — People, companies, tools, products
- [[concepts/]] — Ideas, methods, patterns, frameworks
- [[decisions/]] — Decision records with context and reasoning
- [[projects/]] — Active project knowledge
- [[areas/]] — Ongoing responsibilities
- [[research/]] — Research notes and findings

## Quick Start

Start adding pages by talking to ${state.agentName} or creating files directly.
`;
}

function generateEnvFile(state: WorkspaceConfig): string {
  const providerBlock = state.provider === 'ollama'
    ? `# Using Ollama (local). No API key needed.\n# LODESTONE_MODEL=${state.model}`
    : state.provider === 'openai'
    ? `# OpenAI API key — required for OpenAI models\nOPENAI_API_KEY=sk-...\n#\n# Your chosen model: ${state.model}`
    : `# Anthropic API key — required for Anthropic models\nANTHROPIC_API_KEY=sk-ant-...\n#\n# Your chosen model: ${state.model}`;

  return `# Lodestone Environment Variables
# ⚠️  NEVER commit this file to git. .env is in .gitignore.
# ⚠️  For production, use .env.local (also gitignored) or env vars.

${providerBlock}

# Channel tokens (uncomment to enable)
# TELEGRAM_BOT_TOKEN=...
# DISCORD_BOT_TOKEN=...
`;
}

function generateGitignore(): string {
  return `# Dependencies
node_modules/

# Build output
dist/

# Environment — contains API keys, NEVER commit
.env
.env.local

# Data — contains vector DB, scratch buffer, logs
workspace/data/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
`;
}