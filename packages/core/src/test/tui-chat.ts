/**
 * Lodestone — TUI Chat
 *
 * A terminal chat interface like OpenClaw's TUI.
 * Streaming output, markdown-ish rendering, status bar, command palette.
 */

import { createInterface } from 'readline';
import chalk from 'chalk';
import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool, WikiSearchTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';

const WORKSPACE = process.env.LODESTONE_WORKSPACE || '/tmp/lodestone-test/workspace';

// ─── ANSI Helpers ──────────────────────────────────────────────────────────

const CLEAR = '\x1B[2J\x1B[H';
const RESET = '\x1B[0m';
const BOLD = '\x1B[1m';
const DIM = '\x1B[2m';
const GREEN = '\x1B[32m';
const CYAN = '\x1B[36m';
const YELLOW = '\x1B[33m';
const MAGENTA = '\x1B[35m';
const RED = '\x1B[31m';
const BLUE = '\x1B[34m';

function hideCursor() { process.stdout.write('\x1B[?25l'); }
function showCursor() { process.stdout.write('\x1B[?25h'); }
function clearScreen() { process.stdout.write(CLEAR); }
function moveTo(row: number, col: number) { process.stdout.write(`\x1B[${row};${col}H`); }
function eraseLine() { process.stdout.write('\x1B[2K\r'); }
function writeAt(row: number, col: number, text: string) {
  process.stdout.write(`\x1B[${row};${col}H\x1B[2K${text}`);
}

// ─── Simple Markdown Renderer ──────────────────────────────────────────────

function renderMarkdown(text: string): string {
  return text
    // Headers
    .replace(/^### (.+)$/gm, `${BOLD}${CYAN}$1${RESET}`)
    .replace(/^## (.+)$/gm, `${BOLD}${CYAN}$1${RESET}`)
    .replace(/^# (.+)$/gm, `${BOLD}${CYAN}$1${RESET}`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    // Italic
    .replace(/\*(.+?)\*/g, `${DIM}$1${RESET}`)
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `${DIM}\`\`\`${lang}${RESET}\n${CYAN}${code.trim()}${RESET}\n${DIM}\`\`\`${RESET}`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    // Bullet points
    .replace(/^- (.+)$/gm, `  ${YELLOW}•${RESET} $1`)
    .replace(/^(\d+)\. (.+)$/gm, `  ${YELLOW}$1.${RESET} $2`)
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${BLUE}$1${RESET} ${DIM}($2)${RESET}`)
    // Horizontal rules
    .replace(/^---$/gm, `${DIM}${'─'.repeat(60)}${RESET}`);
}

// ─── Spinner ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerIdx = 0;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;

function startSpinner(label: string) {
  spinnerIdx = 0;
  spinnerInterval = setInterval(() => {
    eraseLine();
    process.stdout.write(`${MAGENTA}${SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]}${RESET} ${DIM}${label}${RESET}`);
    spinnerIdx++;
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  eraseLine();
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  clearScreen();

  // Header
  console.log(`${BOLD}${MAGENTA}🔮 Lodestone${RESET}  ${DIM}Agent Engine${RESET}`);
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
  console.log('');

  // Boot sequence
  const steps = [
    'Creating engine',
    'Initializing memory',
    'Registering tools',
    'Loading identity',
    'Creating session',
  ];

  let engine: LodestoneEngine;
  let sessionId: string;
  let loop: AgentLoop;
  let identity: any;
  let messageCount = 0;

  for (let i = 0; i < steps.length; i++) {
    process.stdout.write(`  ${DIM}[${i+1}/${steps.length}]${RESET} ${steps[i]}...`);

    switch (i) {
      case 0:
        engine = new LodestoneEngine({
          workspaceRoot: WORKSPACE,
          identityDir: WORKSPACE,
          wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
          memoryDir: resolve(WORKSPACE, 'data/lancedb'),
          llm: {
            default: {
              type: 'ollama',
              model: process.env.LODESTONE_MODEL || 'qwen3:8b',
              baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api',
              contextWindow: 32768,
              maxTokens: 4096,
            },
          },
        });
        break;
      case 1:
        await engine!.memory.init();
        break;
      case 2:
        engine!.registerTool(new WikiResolveTool());
        engine!.registerTool(new WikiSearchTool());
        engine!.registerTool(new SmartRetrieveTool());
        engine!.registerTool(new DecisionLogTool(resolve(WORKSPACE, 'data/decisions.json')));
        engine!.registerTool(new ResumeStateTool());
        engine!.registerTool(new WatchdogTool());
        engine!.registerTool(new BusinessHoursTool());
        break;
      case 3:
        identity = await engine!.identity.load();
        break;
      case 4:
        sessionId = engine!.createSession();
        loop = new AgentLoop(engine!, {
          maxToolRounds: 5,
          maxTokens: 4096,
          temperature: 0.7,
          stream: false,
          autoCapture: true,
          autoRecall: true,
        });
        break;
    }

    process.stdout.write(`\r  ${GREEN}✓${RESET} ${steps[i]}${' '.repeat(20)}\n`);
  }

  console.log('');
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
  console.log(`${BOLD}Identity:${RESET} ${identity!.identity.name}  ${BOLD}Model:${RESET} ${process.env.LODESTONE_MODEL || 'qwen3:8b'}`);
  console.log(`${DIM}Type a message to chat. Commands: /help /tools /memory /state /quit${RESET}`);
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
  console.log('');

  // ─── Chat Loop ─────────────────────────────────────────────────────────

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}${MAGENTA}you${RESET} > `,
  });

  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) { rl.prompt(); return; }

    // ─── Commands ─────────────────────────────────────────────────────

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log(`\n${MAGENTA}🔮 Goodbye!${RESET}`);
      await engine!.stop();
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/help') {
      console.log('');
      console.log(`  ${BOLD}Commands:${RESET}`);
      console.log(`    ${CYAN}/help${RESET}    — Show this message`);
      console.log(`    ${CYAN}/tools${RESET}   — List registered tools`);
      console.log(`    ${CYAN}/memory${RESET}  — Show memory stats`);
      console.log(`    ${CYAN}/state${RESET}   — Show session state`);
      console.log(`    ${CYAN}/wiki${RESET}    — List wiki pages`);
      console.log(`    ${CYAN}/reset${RESET}   — Start a new session`);
      console.log(`    ${CYAN}/quit${RESET}    — Exit`);
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/tools') {
      const tools = engine!.tools.listDefinitions();
      console.log('');
      console.log(`  ${BOLD}Tools (${tools.length}):${RESET}`);
      for (const t of tools) {
        console.log(`    ${CYAN}${t.name.padEnd(18)}${RESET} ${t.description}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/memory') {
      const wikiPages = await engine!.memory.wiki.list();
      const state = await engine!.memory.loadSessionState();
      console.log('');
      console.log(`  ${BOLD}Wiki pages:${RESET}    ${wikiPages.length}`);
      console.log(`  ${BOLD}Session state:${RESET} ${state ? state.currentTask : 'none'}`);
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/state') {
      const state = await engine!.memory.loadSessionState();
      console.log('');
      if (state) {
        console.log(`  ${BOLD}Task:${RESET}     ${state.currentTask}`);
        console.log(`  ${BOLD}Progress:${RESET}  ${state.progress}`);
        console.log(`  ${BOLD}Mood:${RESET}      ${state.mood}`);
        console.log(`  ${BOLD}Next:${RESET}      ${state.nextSteps.join(', ')}`);
      } else {
        console.log(`  ${DIM}No session state saved yet.${RESET}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/wiki') {
      const pages = await engine!.memory.wiki.list();
      console.log('');
      console.log(`  ${BOLD}Wiki Pages (${pages.length}):${RESET}`);
      for (const p of pages) {
        console.log(`    ${CYAN}[[${p.slug}]]${RESET} — ${p.frontmatter?.title || p.slug}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/reset') {
      sessionId = engine!.createSession();
      messageCount = 0;
      console.log(`\n  ${GREEN}✓${RESET} New session: ${sessionId}\n`);
      rl.prompt();
      return;
    }

    // ─── Send to LLM ─────────────────────────────────────────────────

    messageCount++;
    console.log('');

    startSpinner('thinking');
    const startTime = Date.now();

    try {
      const result = await loop!.run(sessionId!, trimmed);
      stopSpinner();

      // Render response
      console.log(`${BOLD}${MAGENTA}lodestone${RESET} > `);
      console.log('');
      const rendered = renderMarkdown(result.response);
      for (const line of rendered.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log('');

      // Stats line
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const tokens = result.totalTokens || '?';
      const rounds = result.rounds;
      let stats = `${DIM}${duration}s · ${tokens} tokens · round ${rounds}${RESET}`;
      if (result.toolCalls.length > 0) {
        stats += `${DIM} · tools: ${result.toolCalls.map(tc => tc.toolName).join(', ')}${RESET}`;
      }
      console.log(stats);
      console.log('');
    } catch (err) {
      stopSpinner();
      console.log(`${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      console.log('');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    showCursor();
    process.exit(0);
  });
}

main().catch(err => {
  showCursor();
  console.error('Fatal:', err);
  process.exit(1);
});