/**
 * Lodestone — TUI Chat v2
 *
 * Full-featured terminal UI with:
 * - Streaming LLM responses (token-by-token)
 * - Live tool call indicators with spinners
 * - Improvement dashboard (/improve)
 * - Improvement slash commands (/predict, /rbt, /drift, /lessons, /sleep)
 * - Rich tool result rendering
 * - Session state in status bar
 * - Scrollable chat history
 * - Multi-line input (Shift+Enter)
 * - Channel status in status bar
 */

import { TUI, ProcessTerminal, Text, Box, Markdown, Editor, Container, Spacer } from '@earendil-works/pi-tui';
import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { StreamHandler } from '../streaming/handler.js';
import { WikiResolveTool, WikiSearchTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { runOnboarding } from './tui-onboarding.js';

let WORKSPACE = process.env.LODESTONE_WORKSPACE || '/tmp/lodestone-test/workspace';

// ─── Colors (OpenClaw dark palette) ───────────────────────────────────────

const P = {
  text: '#E8E3D5', dim: '#7B7F87', accent: '#F6C453', accent2: '#F2A65A',
  border: '#3C414B', userBg: '#2B2F36', userText: '#F3EEE0', sysText: '#9BA3B2',
  tool: '#F6C453', code: '#F0C987', error: '#DC2626', success: '#7DD3A5',
  quote: '#8CC8FF', quoteBorder: '#3B4D6B', warn: '#FBBF24', info: '#60A5FA',
  purple: '#A78BFA', pink: '#F472B6',
};
const R = '\x1B[0m'; const B = '\x1B[1m'; const D = '\x1B[2m'; const I = '\x1B[3m';
function fg(c: string) { return `\x1B[38;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }
function bg(c: string) { return `\x1B[48;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }

// ─── Spinner frames ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerIdx = 0;
function spinner() { return SPINNER_FRAMES[spinnerIdx++ % SPINNER_FRAMES.length]; }

// ─── Markdown theme ─────────────────────────────────────────────────────────

const mdTheme = {
  heading: (s: string) => `${B}${fg(P.accent)}${s}${R}`,
  bold: (s: string) => `${B}${s}${R}`,
  italic: (s: string) => `${I}${s}${R}`,
  strikethrough: (s: string) => `\x1B[9m${s}${R}`,
  underline: (s: string) => `\x1B[4m${s}${R}`,
  link: (s: string) => `${fg(P.success)}${s}${R}`,
  linkUrl: (s: string) => `${D}${s}${R}`,
  code: (s: string) => `${fg(P.code)}${s}${R}`,
  codeBlock: (s: string) => `${fg(P.code)}${s}${R}`,
  codeBlockBorder: (s: string) => `${fg(P.border)}${s}${R}`,
  quote: (s: string) => `${fg(P.quote)}${s}${R}`,
  quoteBorder: (s: string) => `${fg(P.quoteBorder)}${s}${R}`,
  hr: (s: string) => `${fg(P.border)}${s}${R}`,
  listBullet: (s: string) => `${fg(P.accent2)}${s}${R}`,
  highlightCode: (code: string) => code.split('\n').map((line: string) => `${fg(P.code)}${line}`),
};

// ─── Message type ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts: number;
  tokens?: number;
  ms?: number;
  tools?: string[];
  streaming?: boolean;
  toolName?: string;
  toolSuccess?: boolean;
  toolDuration?: number;
  toolSummary?: string;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildUserMessage(msg: ChatMessage): string {
  return `**you** ${D}${formatTimestamp(msg.ts)}${R}\n${msg.text}`;
}

function buildAssistantMessage(msg: ChatMessage, agentName: string = 'Lodestone'): string {
  const stats: string[] = [];
  if (msg.ms) stats.push(formatDuration(msg.ms));
  if (msg.tokens) stats.push(`${msg.tokens} tok`);
  if (msg.tools?.length) stats.push(`⚡${msg.tools.join(',')}`);
  const statsLine = stats.length > 0 ? `\n[${stats.join(' · ')}]` : '';
  return `**🔮 ${agentName}** ${D}${formatTimestamp(msg.ts)}${R}\n${msg.text}${statsLine}`;
}

function buildToolMessage(msg: ChatMessage): string {
  const icon = msg.toolSuccess ? `${fg(P.success)}✓${R}` : `${fg(P.error)}✗${R}`;
  const dur = msg.toolDuration ? ` ${D}${formatDuration(msg.toolDuration)}${R}` : '';
  return `${icon} ${fg(P.tool)}${msg.toolName}${R}${dur}${msg.toolSummary ? ` — ${D}${msg.toolSummary.slice(0, 120)}${R}` : ''}`;
}

function buildSystemMessage(msg: ChatMessage): string {
  return `${D}${fg(P.sysText)}${msg.text}${R}`;
}

// ─── Improvement Dashboard ──────────────────────────────────────────────────

async function buildImproveDashboard(engine: LodestoneEngine): Promise<string> {
  const imp = engine.improvement;
  const lines: string[] = [];

  lines.push(`${B}${fg(P.accent)}🔮 Self-Improvement Dashboard${R}\n`);

  // Prediction Journal
  try {
    const calib = await imp.predictionJournal.calibrate();
    const pending = await imp.predictionJournal.list({ status: 'pending' });
    const met = await imp.predictionJournal.list({ status: 'met' });
    const missed = await imp.predictionJournal.list({ status: 'missed' });
    lines.push(`${B}${fg(P.info)}📊 Predictions${R}`);
    lines.push(`  Total: ${calib.totalPredictions}  |  Pending: ${pending.length}  |  Met: ${met.length}  |  Missed: ${missed.length}`);
    lines.push(`  Accuracy: ${(calib.accuracy * 100).toFixed(0)}%  |  Brier Score: ${calib.brierScore.toFixed(3)}`);
    if (calib.buckets && calib.buckets.length > 0) {
      lines.push(`  Calibration: ` + calib.buckets.map((b: any) =>
        `${(b.range[0] * 100).toFixed(0)}-${(b.range[1] * 100).toFixed(0)}%: ${(b.accuracy * 100).toFixed(0)}% accurate`
      ).join(', '));
    }
    lines.push('');
  } catch (e: any) {
    lines.push(`${fg(P.warn)}⚠ Predictions: ${e.message}${R}\n`);
  }

  // RBT Diagnosis
  try {
    const latest = await imp.rbtDiagnosis.getLatest();
    lines.push(`${B}${fg(P.success)}🌹 RBT Diagnosis${R}`);
    if (latest) {
      lines.push(`  Roses: ${latest.roses.length}  |  Buds: ${latest.buds.length}  |  Thorns: ${latest.thorns.length}`);
      if (latest.summary) lines.push(`  ${D}${latest.summary.slice(0, 150)}${R}`);
    } else {
      lines.push(`  ${D}No RBT reports yet. Run /rbt to create one.${R}`);
    }
    lines.push('');
  } catch (e: any) {
    lines.push(`${fg(P.warn)}⚠ RBT: ${e.message}${R}\n`);
  }

  // Drift Detector
  try {
    const latestDrift = await imp.driftDetector.getLatest();
    lines.push(`${B}${fg(P.purple)}🧭 Drift${R}`);
    if (latestDrift) {
      const pct = (latestDrift.overallDrift * 100).toFixed(0);
      const color = latestDrift.overallDrift < 0.2 ? fg(P.success) : latestDrift.overallDrift < 0.5 ? fg(P.warn) : fg(P.error);
      lines.push(`  Overall drift: ${color}${pct}%${R}  |  Flagged: ${latestDrift.flagged.length}`);
      if (latestDrift.flagged.length > 0) {
        lines.push(`  ${latestDrift.flagged.slice(0, 3).map((f: any) => `${fg(P.error)}${f.rule || f.principle || 'unknown'}${R}`).join(', ')}`);
      }
    } else {
      lines.push(`  ${D}No drift reports yet. Run /drift to check.${R}`);
    }
    lines.push('');
  } catch (e: any) {
    lines.push(`${fg(P.warn)}⚠ Drift: ${e.message}${R}\n`);
  }

  // Skill Evolution
  try {
    const lessons = await imp.skillEvolver.listLessons({ limit: 100 });
    const skills = await imp.skillEvolver.listSkills();
    const validated = lessons.filter((l: any) => l.validations >= 2);
    const contradicted = lessons.filter((l: any) => l.contradictions > 0);
    lines.push(`${B}${fg(P.pink)}🧬 Skills & Lessons${R}`);
    lines.push(`  Lessons: ${lessons.length}  |  Validated (2+): ${validated.length}  |  Contradicted: ${contradicted.length}`);
    lines.push(`  Promoted skills: ${skills.length}`);
    if (lessons.length > 0) {
      lines.push(`  Recent: ${lessons.slice(0, 3).map((l: any) => `"${l.lesson.slice(0, 40)}..." (${(l.confidence * 100).toFixed(0)}%)`).join('\n           ')}`);
    }
    lines.push('');
  } catch (e: any) {
    lines.push(`${fg(P.warn)}⚠ Skills: ${e.message}${R}\n`);
  }

  // Sleep Cycle
  try {
    const sleepJob = imp.getSleepCycleJob();
    lines.push(`${B}🌙 Sleep Cycle${R}`);
    lines.push(`  Schedule: ${sleepJob.schedule.kind === 'cron' ? sleepJob.schedule.expr : 'interval'}  |  Enabled: ${sleepJob.enabled ? '✓' : '✗'}`);
  } catch (e: any) {
    lines.push(`${fg(P.warn)}⚠ Sleep: ${e.message}${R}`);
  }

  return lines.join('\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // ─── TUI Setup ────────────────────────────────────────────────────────

  const term = new ProcessTerminal();
  const tui = new TUI(term);

  const chatLog = new Container();

  const bootMsg = new Markdown('', 1, 1, mdTheme as any);
  bootMsg.setText(`${B}${fg(P.accent)}🔮 Lodestone${R}  Booting...`);
  chatLog.addChild(bootMsg);
  chatLog.addChild(new Spacer(1));

  const statusText = new Text(` ${B}${fg(P.accent)}🔮${R} Booting... `, 0, 0);
  const statusBar = new Box(0, 0, (line: string) => `${bg('#1E232A')}${line}${R}`);
  statusBar.addChild(statusText);

  const selectListTheme = {
    selectedBg: (s: string) => bg(P.border) + s + R,
    selectedFg: (s: string) => `${fg(P.accent)}${s}${R}`,
    itemBg: (s: string) => s,
    itemFg: (s: string) => `${D}${s}${R}`,
    descriptionBg: (s: string) => s,
    descriptionFg: (s: string) => `${D}${s}${R}`,
    borderChar: '─',
    borderFg: fg(P.border),
    scrollIndicator: '▼',
    scrollFg: D,
    maxVisible: 5,
  };

  const editor = new Editor(tui, {
    borderColor: (s: string) => `${fg(P.border)}${s}${R}`,
    selectList: selectListTheme as any,
  });

  // Layout: chatLog (flex) → status bar → editor (bottom)
  (tui as any).addChild(chatLog, 1);
  tui.addChild(statusBar);
  tui.addChild(editor);
  tui.setFocus(editor);

  // Start TUI immediately
  tui.start();


  // ─── Submit Handler ──────────────────────────────────────────────────

  editor.onSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    editor.setText('');

    // Check slash commands
    if (trimmed.startsWith('/')) {
      const handled = await handleCommand(trimmed);
      if (handled) return;
    }

    // ─── LLM with streaming ─────────────────────────────────────────

    isProcessing = true;
    msgCount++;
    const userMsg = { role: 'user' as const, text: trimmed, ts: Date.now() };
    messages.push(userMsg);
    addMessage(userMsg);
    tui.requestRender();
    updateStatus('thinking', 'waiting for LLM');

    // Create stream handler for live updates
    const streamHandler = new StreamHandler();
    let currentToolName = '';

    // Handle text deltas — update streaming message
    streamHandler.on('text_delta', (event) => {
      const delta = (event.data as { text: string }).text;
      if (!streamingMd) {
        startStreamingMessage();
        updateStatus('streaming');
      }
      appendStreamingText(delta);
    });

    // Handle tool calls — show indicator
    streamHandler.on('tool_call_start', (event) => {
      const data = event.data as { toolCallId: string; toolName: string };
      currentToolName = data.toolName;
      updateStatus('tool', data.toolName);

      // Add a tool indicator message
      messages.push({
        role: 'tool',
        text: '',
        ts: Date.now(),
        toolName: data.toolName,
        toolSuccess: true,
        toolDuration: 0,
        toolSummary: 'running...',
      });
      // Don't refresh yet — tool result will come
    });

    // Handle tool results — update with result
    streamHandler.on('tool_result', (event) => {
      const data = event.data as { toolName: string; success: boolean; result: string; durationMs: number };
      // Update the last tool message
      const lastTool = [...messages].reverse().find(m => m.role === 'tool' && m.toolName === data.toolName);
      if (lastTool) {
        lastTool.toolSuccess = data.success;
        lastTool.toolDuration = data.durationMs;
        lastTool.toolSummary = data.result?.slice(0, 120) || '';
      }
      updateStatus('streaming', `tool: ${data.toolName}`);
      refreshAll();
    });

    // Handle stream done
    streamHandler.on('done', () => {
      // Will be handled in the main promise chain
    });

    try {
      const result = await loop.run(currentSessionId, trimmed, streamHandler);

      // Finish streaming message or add new one
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        text: result.response || streamingBuffer || '(no response)',
        ts: Date.now(),
        tokens: result.totalTokens,
        ms: result.durationMs,
        tools: result.toolCalls.map(tc => tc.toolName),
      };

      if (streamingMd) {
        finishStreamingMessage(assistantMsg);
      } else {
        addMessage(assistantMsg);
        messages.push(assistantMsg);
      }

      // Update tool messages with final durations
      for (const tc of result.toolCalls) {
        const toolMsg = [...messages].reverse().find(m => m.role === 'tool' && m.toolName === tc.toolName);
        if (toolMsg) {
          toolMsg.toolDuration = tc.durationMs;
          toolMsg.toolSuccess = tc.success;
          toolMsg.toolSummary = tc.summary?.slice(0, 120) || '';
        }
      }

      isProcessing = false;
      msgCount = messages.filter(m => m.role === 'user').length;
      updateStatus('ready', `${msgCount} msgs`);
      refreshAll();
    } catch (err) {
      const errMsg: ChatMessage = {
        role: 'system',
        text: `${fg(P.error)}**Error:** ${err instanceof Error ? err.message : String(err)}${R}`,
        ts: Date.now(),
      };

      if (streamingMd) {
        streamingMd.setText(buildSystemMessage(errMsg));
      } else {
        addMessage(errMsg);
        messages.push(errMsg);
      }

      isProcessing = false;
      updateStatus('error');
      refreshAll();
    }
  };


  // ─── Scroll & Keyboard Handler ────────────────────────────────────────

  // PageUp/PageDown scroll the chat log
  // Home/End jump to top/bottom
  tui.addInputListener((data: string) => {
    // PgUp: \x1b[5~ or \x1b[5;~
    if (data === '\x1b[5~' || data === '\x1b[5;~') {
      scrollOffset = Math.min(scrollOffset + 10, MAX_SCROLL);
      updateStatus('ready');
      // Scroll chatLog by re-rendering with offset
      // pi-tui doesn't have native scroll, so we just update the indicator
      return { consume: true };
    }
    // PgDn: \x1b[6~ or \x1b[6;~
    if (data === '\x1b[6~' || data === '\x1b[6;~') {
      scrollOffset = Math.max(scrollOffset - 10, 0);
      updateStatus('ready');
      return { consume: true };
    }
    // Home: \x1b[H or \x1b[1~
    if (data === '\x1b[H' || data === '\x1b[1~') {
      scrollOffset = MAX_SCROLL;
      updateStatus('ready');
      return { consume: true };
    }
    // End: \x1b[F or \x1b[4~
    if (data === '\x1b[F' || data === '\x1b[4~') {
      scrollOffset = 0;
      updateStatus('ready');
      return { consume: true };
    }
    return undefined;
  });

  // ─── State ─────────────────────────────────────────────────────────────

  const messages: ChatMessage[] = [];
  let isProcessing = false;
  let engine: LodestoneEngine;
  let sessionId: string;
  let loop: AgentLoop;
  let identity: any;
  let displayName = 'Lodestone';  // Updated after onboarding/identity load
  let currentSessionId: string;
  let msgCount = 0;
  let streamingBuffer = '';
  let scrollOffset = 0; // 0 = bottom, positive = scrolled up
  const MAX_SCROLL = 1000;

  const model = process.env.LODESTONE_MODEL || 'glm-5.1:cloud';

  // ─── Onboarding check ───────────────────────────────────────────────────

  // If workspace doesn't exist or has no identity, run onboarding
  const workspaceExists = existsSync(resolve(WORKSPACE, 'IDENTITY.md'));
  let onboardingResult: { workspace: string; agentName: string; userName: string; model: string; provider: string } | null = null;

  if (!workspaceExists) {
    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\n\nNo workspace found. Let\u2019s set one up!`);
    tui.requestRender();

    onboardingResult = await runOnboarding(messages, addMessage, editor, refreshAll, updateStatus, WORKSPACE);

    if (!onboardingResult) {
      // User cancelled onboarding
      tui.stop();
      process.stdout.write(`\n${D}Setup cancelled.${R}\n\n`);
      process.exit(0);
    }

    // Update workspace path and model from onboarding
    process.env.LODESTONE_WORKSPACE = onboardingResult.workspace;
    process.env.LODESTONE_MODEL = onboardingResult.model;

    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\n\nWorkspace created! Booting...`);
    tui.requestRender();
  }

  // ─── Boot ──────────────────────────────────────────────────────────────

  try {
    // Use onboarding result if available
    if (onboardingResult) {
      WORKSPACE = onboardingResult.workspace;
      displayName = onboardingResult.agentName || 'Lodestone';
    }
    const effectiveModel = onboardingResult?.model || model;
    const effectiveProvider = onboardingResult?.provider || 'ollama';
    const effectiveBaseUrl = effectiveProvider === 'ollama'
      ? (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api')
      : undefined; // OpenAI/Anthropic use default endpoints

    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nCreating engine...`);
    tui.requestRender();

    const llmConfig: any = {
      default: {
        type: effectiveProvider,
        model: effectiveModel,
        contextWindow: 32768,
        maxTokens: 4096,
      },
    };
    if (effectiveProvider === 'ollama') {
      llmConfig.default.baseUrl = effectiveBaseUrl;
    } else if (effectiveProvider === 'openai') {
      llmConfig.default.apiKey = process.env.OPENAI_API_KEY;
    } else if (effectiveProvider === 'anthropic') {
      llmConfig.default.apiKey = process.env.ANTHROPIC_API_KEY;
    }

    engine = new LodestoneEngine({
      workspaceRoot: WORKSPACE,
      identityDir: WORKSPACE,
      wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
      memoryDir: resolve(WORKSPACE, 'data/lancedb'),
      llm: llmConfig,
    });

    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nInitializing memory...`);
    tui.requestRender();
    await engine.memory.init();

    // Init improvement system
    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nInitializing self-improvement...`);
    tui.requestRender();
    await engine.improvement.init();

    // Register tools
    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nRegistering tools...`);
    tui.requestRender();
    engine.registerTool(new WikiResolveTool());
    engine.registerTool(new WikiSearchTool());
    engine.registerTool(new SmartRetrieveTool());
    engine.registerTool(new DecisionLogTool(resolve(WORKSPACE, 'data/decisions.json')));
    engine.registerTool(new ResumeStateTool());
    engine.registerTool(new WatchdogTool());
    engine.registerTool(new BusinessHoursTool());

    // Register improvement tools
    for (const tool of engine.improvement.getTools()) {
      engine.registerTool(tool);
    }

    // Load identity
    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nLoading identity...`);
    tui.requestRender();
    identity = await engine.identity.load();
    displayName = identity?.identity?.name || displayName;

    // Create session
    bootMsg.setText(`${B}${fg(P.accent)}🔮 ${displayName}${R}\nCreating session...`);
    tui.requestRender();
    sessionId = engine.createSession();
    currentSessionId = sessionId;
    loop = new AgentLoop(engine, {
      maxToolRounds: 10, maxTokens: 4096, temperature: 0.7,
      stream: true, autoCapture: true, autoRecall: true,
    });

    // Boot complete
    const toolCount = engine.tools.listDefinitions().length;
    const welcomeText = [
      `${B}${fg(P.accent)}🔮 ${displayName} ready.${R}`,
      `**Identity:** ${identity.identity.name}  \u00b7  **Model:** ${effectiveModel}  \u00b7  **Tools:** ${toolCount}`,
      `Self-improvement: ${fg(P.success)}\u2713${R}  \u00b7  Predictions  \u00b7  RBT  \u00b7  Drift  \u00b7  Skills  \u00b7  Sleep`,
      '',
      'Type a message to chat, or /help for commands.',
      `${fg(P.dim)}Tip: Alt+Enter for multi-line input. PgUp/PgDn to scroll.${R}`,
    ].join('\n');
    bootMsg.setText(welcomeText);
    updateStatus('ready');
    tui.requestRender();

  } catch (err) {
    bootMsg.setText(`${fg(P.error)}**Boot failed:** ${err instanceof Error ? err.message : String(err)}`);
    statusText.setText(` ${fg(P.error)}✗${R} Boot failed `);
    tui.requestRender();
    console.error('Boot error:', err);
    return;
  }

  // ─── Status Bar ────────────────────────────────────────────────────────

  function updateStatus(state: 'ready' | 'thinking' | 'tool' | 'streaming' | 'error' | 'setup', detail?: string) {
    const icon = state === 'ready' ? `${fg(P.success)}✓${R}`
      : state === 'thinking' ? `${fg(P.accent)}⚡${R} ${spinner()}`
      : state === 'tool' ? `${fg(P.tool)}⚙${R} ${spinner()}`
      : state === 'streaming' ? `${fg(P.accent)}🔮${R} ${spinner()}`
      : state === 'setup' ? `${fg(P.accent)}🔮${R} ${spinner()}`
      : `${fg(P.error)}✗${R}`;
    const stateLabel = state === 'ready' ? 'Ready'
      : state === 'thinking' ? 'Thinking'
      : state === 'tool' ? `Tool: ${detail || '...'}`
      : state === 'streaming' ? 'Streaming'
      : state === 'setup' ? (detail || 'Setup')
      : 'Error';
    const msgLabel = `${msgCount} msgs`;

    // Channel status
    let channelLabel = '';
    if (engine?.channelManager && engine.channelManager.isRunning()) {
      const channels = engine.channelManager.listChannels();
      if (channels.length > 0) {
        channelLabel = ` ${fg(P.dim)}│${R} ${channels.map(c => `${fg(P.success)}${c.name}✓${R}`).join(' ')}`;
      }
    }

    // Scroll indicator
    const scrollLabel = scrollOffset > 0 ? ` ${fg(P.dim)}│${R} ${fg(P.warn)}↑${scrollOffset}${R}` : '';

    statusText.setText(
      ` ${B}${fg(P.accent)}🔮${R} ${displayName} ${fg(P.dim)}│${R} ${model || '...'} ${fg(P.dim)}│${R} ${icon} ${stateLabel} ${fg(P.dim)}│${R} ${msgLabel}${channelLabel}${scrollLabel} ${detail && state !== 'tool' ? `${fg(P.dim)}│${R} ${detail}` : ''} `
    );
    tui.requestRender();
  }

  // ─── Message Rendering ─────────────────────────────────────────────────

  function addMessage(msg: ChatMessage) {
    scrollOffset = 0; // Auto-scroll to bottom on new message
    const md = new Markdown('', 1, 1, mdTheme as any);
    let content: string;
    if (msg.role === 'user') content = buildUserMessage(msg);
    else if (msg.role === 'assistant') content = buildAssistantMessage(msg, displayName);
    else if (msg.role === 'tool') content = buildToolMessage(msg);
    else content = buildSystemMessage(msg);

    md.setText(content);

    const wrapper = new Container();
    wrapper.addChild(md);
    wrapper.addChild(new Spacer(1));
    chatLog.addChild(wrapper);
  }

  // Streaming: update the last assistant message in-place
  let streamingMd: Markdown | null = null;
  let streamingWrapper: Container | null = null;

  function startStreamingMessage() {
    scrollOffset = 0; // Auto-scroll to bottom
    streamingBuffer = '';
    streamingMd = new Markdown('', 1, 1, mdTheme as any);
    streamingWrapper = new Container();
    streamingWrapper.addChild(streamingMd);
    streamingWrapper.addChild(new Spacer(1));
    chatLog.addChild(streamingWrapper);
  }

  function appendStreamingText(delta: string) {
    streamingBuffer += delta;
    if (streamingMd) {
      streamingMd.setText(`**🔮 ${displayName}** ${D}${formatTimestamp(Date.now())}${R} ${fg(P.dim)}streaming...${R}\n${streamingBuffer}`);
      tui.requestRender();
    }
  }

  function finishStreamingMessage(msg: ChatMessage) {
    if (streamingMd && streamingWrapper) {
      // Replace with final rendered message
      streamingMd.setText(buildAssistantMessage(msg, displayName));
      tui.requestRender();
    }
    streamingMd = null;
    streamingWrapper = null;
    streamingBuffer = '';
  }

  function refreshAll() {
    // Add any messages that aren't yet visually in chatLog
    // chatLog.children.length should match messages.length unless streaming
    // During streaming, there's an extra wrapper — skip adding in that case
    const currentCount = chatLog.children.length;
    const expectedCount = messages.length;
    if (currentCount < expectedCount) {
      // Add missing messages
      for (let i = currentCount; i < expectedCount; i++) {
        addMessage(messages[i]);
      }
    }
    tui.requestRender();
  }

  // ─── Slash Commands ─────────────────────────────────────────────────────

  async function handleCommand(input: string): Promise<boolean> {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/help':
        messages.push({ role: 'system', text: [
          '**Commands:**',
          '  /help — Show this help',
          '  /setup — Re-run setup wizard',
          '  /tools — List available tools',
          '  /memory — Show memory stats',
          '  /state — Show session state',
          '  /wiki — List wiki pages',
          '  /improve — Self-improvement dashboard',
          '  /predict <task> | <expected> <confidence> — Log a prediction',
          '  /rbt — Run RBT diagnosis on recent activity',
          '  /drift — Check identity drift',
          '  /lessons — List learned lessons',
          '  /sleep — Run sleep cycle now',
          '  /channels — Show channel status',
          '  /reset — New session',
          '  /quit — Exit',
          '',
          '**Navigation:**',
          '  PgUp / PgDn — Scroll chat history',
          '  End / Home — Jump to bottom / top',
          '  Alt+Enter — Insert newline (multi-line input)',
          '  Esc / Ctrl+C — Exit',
        ].join('\n'), ts: Date.now() });
        refreshAll();
        return true;

      case '/tools': {
        const tools = engine.tools.listDefinitions();
        messages.push({ role: 'system', text: `**${tools.length} tools:**\n` + tools.map(t => `- \`${t.name}\` — ${t.description}`).join('\n'), ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/memory': {
        const pages = await engine.memory.wiki.list();
        messages.push({ role: 'system', text: `**Wiki:** ${pages.length} pages`, ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/state': {
        const state = await engine.memory.loadSessionState();
        messages.push({ role: 'system', text: state ? `**Task:** ${state.currentTask}\n**Progress:** ${state.progress}` : 'No state yet.', ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/wiki': {
        const pages = await engine.memory.wiki.list();
        messages.push({ role: 'system', text: `**${pages.length} pages:**\n` + pages.map(x => `- [[${x.slug}]] — ${x.frontmatter?.title || x.slug}`).join('\n'), ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/improve': {
        const dashboard = await buildImproveDashboard(engine);
        messages.push({ role: 'system', text: dashboard, ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/predict': {
        // /predict <task> | <expected outcome> | <confidence 0-1>
        const predictText = args.join(' ');
        const predictParts = predictText.split('|').map(s => s.trim());
        if (predictParts.length < 3) {
          messages.push({ role: 'system', text: `${fg(P.warn)}Usage: /predict <task> | <expected outcome> | <confidence 0-1>${R}`, ts: Date.now() });
          refreshAll();
          return true;
        }
        const [task, expected, confStr] = predictParts;
        const confidence = parseFloat(confStr);
        if (isNaN(confidence) || confidence < 0 || confidence > 1) {
          messages.push({ role: 'system', text: `${fg(P.error)}Confidence must be 0-1${R}`, ts: Date.now() });
          refreshAll();
          return true;
        }
        try {
          const pred = await engine.improvement.predictionJournal.predict(
            task, expected, confidence,
            new Date(Date.now() + 86400000).toISOString(),
            ['tui']
          );
          messages.push({ role: 'system', text: `${fg(P.success)}✓${R} Prediction logged: \`${pred.id}\`\n**Task:** ${task}\n**Expected:** ${expected}\n**Confidence:** ${(confidence * 100).toFixed(0)}%\nResolve with: ask me "resolve prediction ${pred.id} as <outcome>"`, ts: Date.now() });
        } catch (e: any) {
          messages.push({ role: 'system', text: `${fg(P.error)}Error: ${e.message}${R}`, ts: Date.now() });
        }
        refreshAll();
        return true;
      }

      case '/rbt': {
        // Run RBT diagnosis — use messages as activity
        const activities = messages
          .filter(m => m.role === 'assistant' || m.role === 'user')
          .slice(-10)
          .map(m => ({
            action: m.text.slice(0, 80),
            timestamp: new Date(m.ts).toISOString(),
            outcome: (m.role === 'assistant' ? 'success' : 'partial') as 'success' | 'partial',
            category: 'conversation' as string,
          }));
        // Add a default if empty
        if (activities.length === 0) {
          activities.push({ action: 'Started TUI session', timestamp: new Date().toISOString(), outcome: 'success' as const, category: 'system' });
        }
        try {
          const report = await engine.improvement.rbtDiagnosis.diagnose(activities);
          const lines = [
            `${B}${fg(P.success)}🌹 RBT Diagnosis${R}`,
            `**Roses (${report.roses.length}):** ${report.roses.map((r: any) => r.action || r.description || 'unknown').join(', ') || 'none'}`,
            `**Buds (${report.buds.length}):** ${report.buds.map((b: any) => b.action || b.description || 'unknown').join(', ') || 'none'}`,
            `**Thorns (${report.thorns.length}):** ${report.thorns.map((t: any) => t.action || t.description || 'unknown').join(', ') || 'none'}`,
            `**Summary:** ${report.summary}`,
          ];
          messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
        } catch (e: any) {
          messages.push({ role: 'system', text: `${fg(P.error)}RBT Error: ${e.message}${R}`, ts: Date.now() });
        }
        refreshAll();
        return true;
      }

      case '/drift': {
        try {
          // Use identity rules from loaded identity
          const rules = identity.rules?.raw || 'No rules loaded';
          const ruleLines = rules.split('\n').filter((l: string) => l.trim().match(/^\d+\./));
          const identityRules = ruleLines.map((l: string) => ({
            name: l.replace(/^\d+\.\s*/, '').split(/[:.]/)[0].trim().toLowerCase().replace(/\s+/g, '-'),
            statement: l.replace(/^\d+\.\s*/, '').trim(),
            category: 'identity',
            weight: 1.0,
          }));
          if (identityRules.length === 0) {
            identityRules.push({ name: 'safety', statement: 'Be safe and helpful', category: 'safety', weight: 1.0 });
          }

          // Use recent assistant messages as decisions
          const decisions = messages
            .filter(m => m.role === 'assistant')
            .slice(-5)
            .map(m => ({
              decision: m.text.slice(0, 80),
              rationale: 'TUI conversation',
              timestamp: new Date(m.ts).toISOString(),
              tags: ['conversation'],
            }));

          const report = await engine.improvement.driftDetector.check(identityRules, decisions.length > 0 ? decisions : [{
            decision: 'Started TUI session',
            rationale: 'Initial session',
            timestamp: new Date().toISOString(),
            tags: ['system'],
          }]);
          const pct = (report.overallDrift * 100).toFixed(0);
          const color = report.overallDrift < 0.2 ? fg(P.success) : report.overallDrift < 0.5 ? fg(P.warn) : fg(P.error);
          const lines = [
            `${B}${fg(P.purple)}🧭 Drift Report${R}`,
            `**Overall drift:** ${color}${pct}%${R}`,
            `**Flagged:** ${report.flagged.length} deviations`,
          ];
          if (report.flagged.length > 0) {
            lines.push(`**Deviations:**`);
            for (const f of report.flagged.slice(0, 5)) {
              lines.push(`  - ${fg(P.error)}${f.rule}${R}: ${f.reasoning || ''}`);
            }
          }
          if (report.suggestions && report.suggestions.length > 0) {
            lines.push(`**Suggestions:**`);
            for (const s of report.suggestions.slice(0, 3)) {
              lines.push(`  - ${s}`);
            }
          }
          messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
        } catch (e: any) {
          messages.push({ role: 'system', text: `${fg(P.error)}Drift Error: ${e.message}${R}`, ts: Date.now() });
        }
        refreshAll();
        return true;
      }

      case '/lessons': {
        try {
          const lessons = await engine.improvement.skillEvolver.listLessons({ limit: 20 });
          const skills = await engine.improvement.skillEvolver.listSkills();
          const lines = [
            `${B}${fg(P.pink)}🧬 Lessons & Skills${R}`,
            `**${lessons.length} lessons** · **${skills.length} promoted skills**`,
          ];
          if (lessons.length > 0) {
            lines.push('');
            for (const l of lessons.slice(0, 10)) {
              const conf = `${fg(l.confidence >= 0.7 ? P.success : l.confidence >= 0.4 ? P.warn : P.error)}${(l.confidence * 100).toFixed(0)}%${R}`;
              const status = l.promoted ? `${fg(P.success)}★ promoted${R}` : `${D}${l.validations}v/${l.contradictions}c${R}`;
              lines.push(`  - "${l.lesson.slice(0, 60)}${l.lesson.length > 60 ? '...' : ''}" ${conf} ${status}`);
            }
          }
          messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
        } catch (e: any) {
          messages.push({ role: 'system', text: `${fg(P.error)}Lessons Error: ${e.message}${R}`, ts: Date.now() });
        }
        refreshAll();
        return true;
      }

      case '/sleep': {
        messages.push({ role: 'system', text: `${fg(P.info)}🌙 Running sleep cycle...${R}`, ts: Date.now() });
        refreshAll();
        updateStatus('thinking', 'sleep cycle');
        try {
          const result = await engine.improvement.sleepCycle.runFullCycle();
          const lines = [
            `${B}${fg(P.info)}🌙 Sleep Cycle Complete${R} (${formatDuration(result.durationMs)})`,
            `**Harvest:** ${result.harvest ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
            `**Mine:** ${result.mine ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
            `**Reflect:** ${result.reflect ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
            `**Consolidate:** ${result.consolidate ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
            `**Validate:** ${result.validate ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
            `**Prepare:** ${result.prepare ? `${fg(P.success)}✓${R}` : `${fg(P.dim)}—${R}`}`,
          ];
          if (result.errors.length > 0) {
            lines.push(`${fg(P.warn)}⚠ ${result.errors.length} errors${R}`);
          }
          messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
          updateStatus('ready');
        } catch (e: any) {
          messages.push({ role: 'system', text: `${fg(P.error)}Sleep Error: ${e.message}${R}`, ts: Date.now() });
          updateStatus('error');
        }
        refreshAll();
        return true;
      }

      case '/channels': {
        if (!engine.channelManager || !engine.channelManager.isRunning()) {
          messages.push({ role: 'system', text: `${fg(P.dim)}No channels configured or running.${R}\n\nTo enable channels, add them to your config:\n${fg(P.code)}channels:\n  telegram:\n    enabled: true\n    botToken: \${TELEGRAM_BOT_TOKEN}${R}`, ts: Date.now() });
          refreshAll();
          return true;
        }
        const channels = engine.channelManager.listChannels();
        const lines = [
          `${B}${fg(P.info)}📡 Channels${R}`,
          `${channels.length} channel(s) active:`,
        ];
        for (const ch of channels) {
          lines.push(`  ${fg(P.success)}✓${R} ${ch.name} (${ch.id})`);
        }
        messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
        refreshAll();
        return true;
      }

      case '/setup': {
        messages.push({ role: 'system', text: `${fg(P.info)}Restarting setup...${R}\nType anything to begin.`, ts: Date.now() });
        refreshAll();
        const setupResult = await runOnboarding(messages, addMessage, editor, refreshAll, updateStatus, WORKSPACE);
        if (setupResult) {
          displayName = setupResult.agentName || displayName;
          updateStatus('setup', 'workspace created');
          messages.push({ role: 'system', text: `${fg(P.success)}Setup complete!${R} Restart to apply all changes.`, ts: Date.now() });
        }
        refreshAll();
        return true;
      }

      case '/reset':
        currentSessionId = engine.createSession();
        messages.push({ role: 'system', text: `New session: \`${currentSessionId}\``, ts: Date.now() });
        refreshAll();
        return true;

      case '/quit':
      case '/exit':
        cleanup();
        return true;

      default:
        return false;
    }
  }

  (editor as any).onEscape = () => { cleanup(); };

  process.on('SIGINT', () => { cleanup(); });
  process.on('SIGTERM', () => { cleanup(); });

  function cleanup() {
    tui.stop();
    process.stdout.write(`\n${B}${fg(P.accent)}🔮 Lodestone${R} session ended.\n\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});