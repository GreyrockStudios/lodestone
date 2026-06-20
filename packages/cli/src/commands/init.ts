/**
 * `lodestone init` — Interactive workspace setup wizard.
 *
 * Creates a new Lodestone workspace with:
 * - Directory structure (workspace/, memory/, data/)
 * - Identity files (IDENTITY.md, SOUL.md, USER.md, RULES.md, HEARTBEAT.md)
 * - Config file (lodestone.config.yaml)
 * - Wiki scaffold (memory/wiki/ with index.md)
 *
 * Options:
 *   --template <name>   Use a pre-built template (general|developer|business|creative|researcher)
 *   --name <name>       Agent name (skips prompt)
 *   --user <name>       User name (skips prompt)
 *   --model <model>     Default LLM model (default: glm-5.2:cloud)
 *   --provider <type>   LLM provider: ollama|openai|anthropic (default: ollama)
 *   --path <dir>        Target directory (default: ./my-agent)
 */

import { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

// Resolve templates directory relative to this package
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../templates');

const AVAILABLE_TEMPLATES = ['general', 'developer', 'business', 'creative', 'researcher'] as const;
type TemplateName = typeof AVAILABLE_TEMPLATES[number];

export function initCommand(): Command {
  const cmd = new Command('init');

  cmd
    .description('Create a new Lodestone workspace with interactive wizard')
    .option('-t, --template <name>', 'Use a pre-built template', 'general')
    .option('-n, --name <name>', 'Agent name (skip prompt)')
    .option('-u, --user <name>', 'User name (skip prompt)')
    .option('-m, --model <model>', 'Default LLM model', 'glm-5.2:cloud')
    .option('-p, --provider <type>', 'LLM provider', 'ollama')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-d, --path <dir>', 'Target directory', './my-agent')
    .action(async (options) => {
      console.log(chalk.cyan('\n🔮 Lodestone Setup Wizard\n'));

      // Validate template
      const template = options.template as TemplateName;
      if (!AVAILABLE_TEMPLATES.includes(template)) {
        console.error(chalk.red(`Unknown template: ${template}. Available: ${AVAILABLE_TEMPLATES.join(', ')}`));
        process.exit(1);
      }

      // Interactive prompts for missing info
      const agentName = options.name || await input({
        message: 'What should your agent be called?',
        default: template === 'developer' ? 'Coder' : template === 'business' ? 'Atlas' : 'Lodestone',
      });

      const userName = options.user || await input({
        message: 'What is your name?',
        default: 'User',
      });

      const workspacePath = resolve(options.path);

      // Confirm
      console.log('');
      console.log(chalk.dim('  Template:    ') + chalk.white(template));
      console.log(chalk.dim('  Agent name:  ') + chalk.white(agentName));
      console.log(chalk.dim('  User name:   ') + chalk.white(userName));
      console.log(chalk.dim('  Model:       ') + chalk.white(options.model));
      console.log(chalk.dim('  Provider:    ') + chalk.white(options.provider));
      console.log(chalk.dim('  Path:        ') + chalk.white(workspacePath));
      console.log('');

      const proceed = options.yes ? true : await confirm({ message: 'Create workspace with these settings?', default: true });
      if (!proceed) {
        console.log(chalk.dim('Cancelled.'));
        process.exit(0);
      }

      // Create workspace structure
      try {
        createWorkspace(workspacePath, {
          template,
          agentName,
          userName,
          model: options.model,
          provider: options.provider,
        });
        console.log(chalk.green(`\n✓ Workspace created at ${workspacePath}`));
        console.log(chalk.dim('\nNext steps:'));
        console.log(chalk.dim(`  cd ${workspacePath}`));
        console.log(chalk.dim('  lodestone start'));
        console.log('');
      } catch (err) {
        console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  return cmd;
}

interface WorkspaceOptions {
  template: TemplateName;
  agentName: string;
  userName: string;
  model: string;
  provider: string;
}

function createWorkspace(root: string, opts: WorkspaceOptions): void {
  // Create directory tree
  const dirs = [
    root,
    join(root, 'workspace'),
    join(root, 'workspace', 'memory'),
    join(root, 'workspace', 'memory', 'wiki'),
    join(root, 'workspace', 'memory', 'wiki', 'entities'),
    join(root, 'workspace', 'memory', 'wiki', 'concepts'),
    join(root, 'workspace', 'memory', 'wiki', 'decisions'),
    join(root, 'workspace', 'memory', 'wiki', 'projects'),
    join(root, 'workspace', 'memory', 'wiki', 'areas'),
    join(root, 'workspace', 'memory', 'wiki', 'research'),
    join(root, 'workspace', 'memory', 'agents'),
    join(root, 'workspace', 'memory', 'agents', 'agent'),
    join(root, 'workspace', 'memory', '00-inbox'),
    join(root, 'workspace', 'data'),
    join(root, 'workspace', 'data', 'lancedb'),
    join(root, 'workspace', 'data', 'logs'),
    join(root, 'workspace', 'memory', 'raw'),
    join(root, 'workspace', 'data', 'improvement'),
    join(root, 'workspace', 'data', 'safety'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy template files
  const templateDir = join(TEMPLATES_DIR, opts.template);
  if (existsSync(templateDir)) {
    // Copy each file individually, replacing placeholders
    const files = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'RULES.md', 'HEARTBEAT.md', 'AGENTS.md'];
    for (const file of files) {
      const src = join(templateDir, file);
      if (existsSync(src)) {
        let content = readFileSync(src, 'utf-8');
        content = content.replace(/\{\{name\}\}/g, opts.agentName);
        content = content.replace(/\{\{userName\}\}/g, opts.userName);
        content = content.replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0]);
        writeFileSync(join(root, 'workspace', file), content);
      }
    }
  } else {
    // Generate minimal identity files
    generateMinimalIdentity(root, opts);
  }

  // Generate config
  writeFileSync(join(root, 'lodestone.config.yaml'), generateConfig(opts));

  // Generate wiki index
  writeFileSync(join(root, 'workspace', 'memory', 'wiki', 'index.md'), generateWikiIndex(opts));

  // Generate .env
  writeFileSync(join(root, '.env'), generateEnvFile(opts));

  // Generate .gitignore
  writeFileSync(join(root, '.gitignore'), generateGitignore());
}

function generateMinimalIdentity(root: string, opts: WorkspaceOptions): void {
  const today = new Date().toISOString().split('T')[0];

  writeFileSync(join(root, 'workspace', 'IDENTITY.md'), [
    `# IDENTITY.md`,
    ``,
    `- **Name:** ${opts.agentName}`,
    `- **Emoji:** 🔮`,
    `- **Creature:** AI assistant — capable, reliable, adaptive`,
    `- **First online:** ${today}`,
    `- **Created with:** Lodestone`,
    `- **Vibe:** Professional. Helpful. Gets things done.`,
    ``,
    `---`,
    ``,
    `${opts.agentName}. Your agent. Customize SOUL.md to define its personality.`,
  ].join('\n'));

  writeFileSync(join(root, 'workspace', 'SOUL.md'), [
    `# SOUL.md — ${opts.agentName}`,
    ``,
    `You are ${opts.agentName}, an AI assistant built with Lodestone.`,
    ``,
    `Be helpful. Be honest. Be thorough. Skip the fluff.`,
    ``,
    `## Principles`,
    ``,
    `1. **Accuracy first** — If you're not sure, say so.`,
    `2. **Action over explanation** — Do things, don't just describe them.`,
    `3. **Context-aware** — Use your memory before searching externally.`,
    `4. **Proactive** — Flag problems early. Don't wait to be asked.`,
    `5. **Concise** — Say what needs to be said. No filler.`,
  ].join('\n'));

  writeFileSync(join(root, 'workspace', 'USER.md'), [
    `# USER.md — ${opts.userName}`,
    ``,
    `${opts.userName} is the primary user.`,
  ].join('\n'));

  writeFileSync(join(root, 'workspace', 'RULES.md'), [
    `# RULES.md — ${opts.agentName} Operating Rules`,
    ``,
    `## Red Lines`,
    ``,
    `- Don't exfiltrate private data. Ever.`,
    `- Don't run destructive commands without asking.`,
    `- When in doubt, ask.`,
  ].join('\n'));

  writeFileSync(join(root, 'workspace', 'HEARTBEAT.md'), [
    `# HEARTBEAT.md — ${opts.agentName}`,
    ``,
    `Pick one thing and make progress. If nothing's active, HEARTBEAT_OK.`,
    ``,
    `## Active`,
    ``,
    `_(No active projects yet — add them here or let the agent discover them)_`,
    ``,
    `## Health Checks`,
    ``,
    `_(No health checks configured — add URLs or commands to monitor)_`,
  ].join('\n'));

  writeFileSync(join(root, 'workspace', 'AGENTS.md'), generateAgentsMd());
}

function generateConfig(opts: WorkspaceOptions): string {
  const providerConfig = opts.provider === 'openai'
    ? [
        `    type: openai`,
        `    model: ${opts.model}`,
        `    apiKey: \${OPENAI_API_KEY}`,
      ].join('\n')
    : opts.provider === 'anthropic'
    ? [
        `    type: anthropic`,
        `    model: ${opts.model}`,
        `    apiKey: \${ANTHROPIC_API_KEY}`,
      ].join('\n')
    : [
        `    type: ollama`,
        `    model: ${opts.model}`,
        `    baseUrl: http://127.0.0.1:11434/api`,
      ].join('\n');

  return `# Lodestone Configuration
# Generated by \`lodestone init\`
# See https://github.com/greyrockstudios/lodestone for full docs

workspace:
  root: ./workspace

llm:
  default:
${providerConfig}
    contextWindow: 128000
    maxTokens: 8192

  # Route specific tasks to different models:
  # routes:
  #   fast:
  #     type: ollama
  #     model: glm-5.2:cloud
  #   smart:
  #     type: openai
  #     model: gpt-4o
  #     apiKey: \${OPENAI_API_KEY}

channels:
  # Telegram bot (set LODESTONE_TELEGRAM_TOKEN to enable)
  # telegram:
  #   enabled: false
  #   botToken: \${TELEGRAM_BOT_TOKEN}

  # Discord bot (set LODESTONE_DISCORD_TOKEN to enable)
  # discord:
  #   enabled: false
  #   botToken: \${DISCORD_BOT_TOKEN}
  #   channelId: ""

  # Web chat (enabled by default for browser-based chat)
  webchat:
    enabled: true
    port: 3000
    corsOrigin: "*"

memory:
  vectorDb:
    provider: lancedb
    path: ./workspace/data/lancedb
    embedding:
      provider: ollama
      model: nomic-embed-text
      dimensions: 768
    autoRecall: true
    autoCapture: true

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

function generateWikiIndex(opts: WorkspaceOptions): string {
  return `---
title: Knowledge Index
created: ${new Date().toISOString().split('T')[0]}
updated: ${new Date().toISOString().split('T')[0]}
status: active
tags: [index]
---

# Knowledge Index

Welcome to ${opts.agentName}'s knowledge base. Pages are organized by category:

## Categories

- [[entities/]] — People, companies, tools, products
- [[concepts/]] — Ideas, methods, patterns, frameworks
- [[decisions/]] — Decision records with context and reasoning
- [[projects/]] — Active project knowledge
- [[areas/]] — Ongoing responsibilities
- [[research/]] — Research notes and findings

## Quick Links

_(Add pages here as the wiki grows. Use [[wikilinks]] to cross-reference.)_
`;
}

function generateEnvFile(opts: WorkspaceOptions): string {
  const lines = [
    `# Lodestone Environment`,
    `# Generated by \`lodestone init\``,
    ``,
    `# LLM Provider`,
  ];

  if (opts.provider === 'ollama') {
    lines.push(`OLLAMA_BASE_URL=http://127.0.0.1:11434`);
  } else if (opts.provider === 'openai') {
    lines.push(`# OPENAI_API_KEY=sk-...`);
    lines.push(`# OLLAMA_BASE_URL=http://127.0.0.1:11434`);
  } else if (opts.provider === 'anthropic') {
    lines.push(`# ANTHROPIC_API_KEY=sk-ant-...`);
    lines.push(`# OLLAMA_BASE_URL=http://127.0.0.1:11434`);
  }

  lines.push(``);
  lines.push(`# Which model to use`);
  lines.push(`LODESTONE_MODEL=${opts.model}`);
  lines.push(``);
  lines.push(`# Logging`);
  lines.push(`LODESTONE_LOG_LEVEL=info`);

  return lines.join('\n');
}

function generateGitignore(): string {
  return `# Dependencies
node_modules/

# Build output
dist/
*.js.map
*.d.ts.map

# Data (user-specific, don't commit)
workspace/data/

# Environment
.env
.env.local

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# Logs
*.log
`;
}
function generateAgentsMd(): string {
  return `# AGENTS.md — Workspace Rules

## Memory Structure
- \`memory/wiki/\` — Curated, cross-linked knowledge base
- \`memory/raw/\` — Immutable sources (never modified after creation)
- \`memory/agents/\` — Per-agent workspaces
- \`00-inbox/\` — Quick capture

## Write Protocol
1. Raw sources are immutable
2. Wiki pages need frontmatter (title, created, updated, status, tags)
3. The log is append-only
4. When in doubt, ask the user

## Security
- Never write secrets to memory or logs
- Don't run destructive commands without asking
- When in doubt, ask
`;
}
