/**
 * Lodestone — TUI Chat
 *
 * Terminal UI using pi-tui (same framework as OpenClaw).
 * Layout: message log (top, flex), status bar, editor input (bottom).
 * Each message is a separate component for efficient rendering.
 */

import { TUI, ProcessTerminal, Text, Box, Markdown, Editor, Container, Spacer } from '@earendil-works/pi-tui';
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

// ─── Colors (matching OpenClaw dark theme) ─────────────────────────────────

const P = {
  text: '#E8E3D5', dim: '#7B7F87', accent: '#F6C453', accent2: '#F2A65A',
  border: '#3C414B', userBg: '#2B2F36', userText: '#F3EEE0', sysText: '#9BA3B2',
  tool: '#F6C453', code: '#F0C987', error: '#DC2626', success: '#7DD3A5',
  quote: '#8CC8FF', quoteBorder: '#3B4D6B',
};
const R = '\x1B[0m'; const B = '\x1B[1m'; const D = '\x1B[2m'; const I = '\x1B[3m';
function fg(c: string) { return `\x1B[38;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }
function bg(c: string) { return `\x1B[48;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }

// ─── Markdown theme (matching OpenClaw) ──────────────────────────────────

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
  quoteBorder: (s: string) => `${fg('#3B4D6B')}${s}${R}`,
  hr: (s: string) => `${fg(P.border)}${s}${R}`,
  listBullet: (s: string) => `${fg(P.accent2)}${s}${R}`,
  highlightCode: (code: string) => code.split('\n').map((line: string) => `${fg(P.code)}${line}`),
};

// ─── Message components ───────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  tokens?: number;
  ms?: number;
  tools?: string[];
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function buildUserMessage(msg: ChatMessage): string {
  const time = formatTimestamp(msg.ts);
  return `${bg(P.userBg)} ${B}${fg(P.userText)}you${R}${bg(P.userBg)} ${D}${time}${R}\n${msg.text}`;
}

function buildAssistantMessage(msg: ChatMessage): string {
  const time = formatTimestamp(msg.ts);
  const stats: string[] = [];
  if (msg.ms) stats.push(`${(msg.ms/1000).toFixed(1)}s`);
  if (msg.tokens) stats.push(`${msg.tokens} tok`);
  if (msg.tools?.length) stats.push(`⚡${msg.tools.join(',')}`);
  const statsLine = stats.length > 0 ? `\n${D}[${stats.join(' · ')}]${R}` : '';
  return `**🔮 lodestone** ${D}${time}${R}\n${msg.text}${statsLine}`;
}

function buildSystemMessage(msg: ChatMessage): string {
  return `${fg(P.sysText)}${msg.text}${R}`;
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}${fg(P.accent)}🔮 Lodestone${R}  ${D}Agent Engine${R}\n`);

  const steps = ['Creating engine','Initializing memory','Registering tools','Loading identity','Creating session'];
  let engine: LodestoneEngine | undefined;
  let sessionId: string | undefined;
  let loop: AgentLoop | undefined;
  let identity: any;

  for (let i = 0; i < steps.length; i++) {
    process.stdout.write(`  ${D}[${i+1}/${steps.length}]${R} ${steps[i]}...`);
    switch (i) {
      case 0: engine = new LodestoneEngine({ workspaceRoot: WORKSPACE, identityDir: WORKSPACE, wikiRoot: resolve(WORKSPACE,'memory/wiki'), memoryDir: resolve(WORKSPACE,'data/lancedb'), llm: { default: { type:'ollama', model: process.env.LODESTONE_MODEL||'qwen3:8b', baseUrl: process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434/api', contextWindow:32768, maxTokens:4096 }}}); break;
      case 1: await engine!.memory.init(); break;
      case 2: engine!.registerTool(new WikiResolveTool()); engine!.registerTool(new WikiSearchTool()); engine!.registerTool(new SmartRetrieveTool()); engine!.registerTool(new DecisionLogTool(resolve(WORKSPACE,'data/decisions.json'))); engine!.registerTool(new ResumeStateTool()); engine!.registerTool(new WatchdogTool()); engine!.registerTool(new BusinessHoursTool()); break;
      case 3: identity = await engine!.identity.load(); break;
      case 4: sessionId = engine!.createSession(); loop = new AgentLoop(engine!,{maxToolRounds:5,maxTokens:4096,temperature:0.7,stream:false,autoCapture:true,autoRecall:true}); break;
    }
    process.stdout.write(`\r  ${fg(P.success)}✓${R} ${steps[i]}${' '.repeat(20)}\n`);
  }

  console.log(`\n${D}${'─'.repeat(60)}${R}`);
  console.log(`${B}Identity:${R} ${identity!.identity.name}   ${B}Model:${R} ${process.env.LODESTONE_MODEL||'qwen3:8b'}\n`);

  // ─── TUI ────────────────────────────────────────────────────────────

  const messages: ChatMessage[] = [];
  const messageComponents: Container[] = []; // Track added components for removal
  let isProcessing = false;
  let currentSessionId = sessionId!;

  const term = new ProcessTerminal();
  const tui = new TUI(term);

  // ─── Chat log (scrollable message area) ─────────────────────────────

  const chatLog = new Container();

  // ─── Status bar ─────────────────────────────────────────────────────

  const statusText = new Text(` ${B}${fg(P.accent)}🔮${R} ${identity!.identity.name} ${fg(P.dim)}│${R} ${process.env.LODESTONE_MODEL||'qwen3:8b'} ${fg(P.dim)}│${R} ${fg(P.success)}✓${R} Ready ${fg(P.dim)}│${R} /help for commands `, 0, 0);
  const statusBar = new Box(0, 0, (line: string) => `${bg('#1E232A')}${line}${R}`);
  statusBar.addChild(statusText);

  // ─── Editor ─────────────────────────────────────────────────────────

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

  // Layout: chatLog (flex) → status bar → editor
  (tui as any).addChild(chatLog, 1);
  tui.addChild(statusBar);
  tui.addChild(editor);
  tui.setFocus(editor);

  // ─── Message rendering ─────────────────────────────────────────────

  function addMessage(msg: ChatMessage) {
    const md = new Markdown('', 1, 1, mdTheme as any);
    let content: string;
    if (msg.role === 'user') {
      content = buildUserMessage(msg);
    } else if (msg.role === 'assistant') {
      content = buildAssistantMessage(msg);
    } else {
      content = buildSystemMessage(msg);
    }
    md.setText(content);

    const wrapper = new Container();
    wrapper.addChild(md);
    wrapper.addChild(new Spacer(1)); // Blank line between messages

    chatLog.addChild(wrapper);
    messageComponents.push(wrapper);
  }

  function refreshAll() {
    // Clear and re-add all messages
    chatLog.clear();
    messageComponents.length = 0;
    for (const msg of messages) {
      addMessage(msg);
    }
    tui.requestRender();
  }

  function setStatus(s: string) {
    statusText.setText(s);
    tui.requestRender();
  }

  // ─── Submit handler ────────────────────────────────────────────────

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;

    editor.setText('');

    // ─── Commands ───────────────────────────────────────────────────

    if (trimmed === '/quit' || trimmed === '/exit') { tui.stop(); process.exit(0); }
    if (trimmed === '/help') {
      messages.push({ role:'system', text:'**Commands:** /help · /tools · /memory · /state · /wiki · /reset · /quit', ts:Date.now() });
      refreshAll(); return;
    }
    if (trimmed === '/tools') {
      const tools = engine!.tools.listDefinitions();
      messages.push({ role:'system', text:`**${tools.length} tools:**\n` + tools.map(t => `- \`${t.name}\` — ${t.description}`).join('\n'), ts:Date.now() });
      refreshAll(); return;
    }
    if (trimmed === '/memory') { engine!.memory.wiki.list().then(p => { messages.push({role:'system',text:`Wiki: **${p.length}** pages`,ts:Date.now()}); refreshAll(); }); return; }
    if (trimmed === '/state') { engine!.memory.loadSessionState().then(s => { messages.push({role:'system',text:s?`**Task:** ${s.currentTask}\n**Progress:** ${s.progress}`:'No state yet.',ts:Date.now()}); refreshAll(); }); return; }
    if (trimmed === '/wiki') { engine!.memory.wiki.list().then(p => { messages.push({role:'system',text:`**${p.length} pages:**\n`+p.map(x=>`- [[${x.slug}]] — ${x.frontmatter?.title||x.slug}`).join('\n'),ts:Date.now()}); refreshAll(); }); return; }
    if (trimmed === '/reset') { currentSessionId = engine!.createSession(); messages.push({role:'system',text:`New session: \`${currentSessionId}\``,ts:Date.now()}); refreshAll(); return; }

    // ─── LLM ────────────────────────────────────────────────────────

    isProcessing = true;
    messages.push({ role:'user', text:trimmed, ts:Date.now() });
    refreshAll();
    setStatus(` ${B}${fg(P.accent)}🔮${R} ${identity!.identity.name} ${fg(P.dim)}│${R} ${process.env.LODESTONE_MODEL||'qwen3:8b'} ${fg(P.dim)}│${R} ${fg(P.accent)}⚡${R} thinking... `);

    loop!.run(currentSessionId, trimmed).then(result => {
      messages.push({ role:'assistant', text:result.response, ts:Date.now(), tokens:result.totalTokens, ms:result.durationMs, tools:result.toolCalls.map(tc=>tc.toolName) });
      isProcessing = false;
      refreshAll();
      setStatus(` ${B}${fg(P.accent)}🔮${R} ${identity!.identity.name} ${fg(P.dim)}│${R} ${process.env.LODESTONE_MODEL||'qwen3:8b'} ${fg(P.dim)}│${R} ${fg(P.success)}✓${R} ${messages.filter(m=>m.role==='user').length} msgs `);
    }).catch(err => {
      messages.push({ role:'system', text:`${fg(P.error)}**Error:** ${err instanceof Error ? err.message : String(err)}${R}`, ts:Date.now() });
      isProcessing = false;
      refreshAll();
      setStatus(` ${B}${fg(P.accent)}🔮${R} ${identity!.identity.name} ${fg(P.dim)}│${R} ${process.env.LODESTONE_MODEL||'qwen3:8b'} ${fg(P.dim)}│${R} ${fg(P.error)}✗${R} Error `);
    });
  };

  (editor as any).onEscape = () => { tui.stop(); process.exit(0); };

  // Start the TUI
  tui.start();

  process.on('SIGINT', () => { tui.stop(); process.exit(0); });
  process.on('SIGTERM', () => { tui.stop(); process.exit(0); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });