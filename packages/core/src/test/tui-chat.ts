/**
 * Lodestone — TUI Chat
 *
 * Terminal UI using pi-tui (same framework as OpenClaw).
 * Layout: header, scrollable messages, status bar, editor input.
 */

import { TUI, ProcessTerminal, Text, Editor, Key, matchesKey } from '@earendil-works/pi-tui';
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

// ─── Colors ────────────────────────────────────────────────────────────────

const P = {
  text: '#E8E3D5', dim: '#7B7F87', accent: '#F6C453', accent2: '#F2A65A',
  border: '#3C414B', userBg: '#2B2F36', userText: '#F3EEE0', sysText: '#9BA3B2',
  tool: '#F6C453', code: '#F0C987', error: '#DC2626', success: '#7DD3A5',
};
const R = '\x1B[0m'; const B = '\x1B[1m'; const D = '\x1B[2m'; const I = '\x1B[3m';
function fg(c: string) { return `\x1B[38;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }
function bg(c: string) { return `\x1B[48;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }

// ─── Message type ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  tokens?: number;
  ms?: number;
  tools?: string[];
}

function renderMessages(msgs: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const t = new Date(m.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (m.role === 'user') {
      lines.push(`${bg(P.userBg)} ${B}${fg(P.userText)}you${R}${bg(P.userBg)} ${D}${t}${R}`);
      for (const l of m.text.split('\n')) lines.push(`${bg(P.userBg)} ${l}${R}`);
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push(`${B}${fg(P.accent)}🔮 lodestone${R} ${D}${t}${R}`);
      for (const l of m.text.split('\n')) lines.push(`  ${l}`);
      if (m.ms || m.tokens) {
        const p: string[] = [];
        if (m.ms) p.push(`${(m.ms/1000).toFixed(1)}s`);
        if (m.tokens) p.push(`${m.tokens} tok`);
        if (m.tools?.length) p.push(`⚡${m.tools.join(',')}`);
        lines.push(`${D}  ${p.join(' · ')}${R}`);
      }
      lines.push('');
    } else {
      lines.push(`  ${fg(P.sysText)}${m.text}${R}`);
      lines.push('');
    }
  }
  return lines.join('\n');
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
  let isProcessing = false;
  let currentSessionId = sessionId!;

  const term = new ProcessTerminal();
  const tui = new TUI(term);

  // Components
  const headerText = new Text(` ${B}${fg(P.accent)}🔮 Lodestone${R}  ${fg(P.dim)}│${R}  ${identity!.identity.name}  ${fg(P.dim)}│${R}  ${process.env.LODESTONE_MODEL||'qwen3:8b'} `, 1, 0);
  const logText = new Text('', 1, 0);
  const statusText = new Text(` ${fg(P.success)}✓${R} ${D}Ready · /help for commands${R} `, 1, 0);

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

  // Layout: TUI IS the root container
  tui.addChild(headerText);
  (tui as any).addChild(logText, 1); // flex=1
  tui.addChild(statusText);
  tui.addChild(editor);
  tui.setFocus(editor);

  // Submit handler
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;

    editor.setText('');

    // ─── Commands ───────────────────────────────────────────────────

    if (trimmed === '/quit' || trimmed === '/exit') { tui.stop(); process.exit(0); }
    if (trimmed === '/help') {
      messages.push({ role:'system', text:'Commands: /help · /tools · /memory · /state · /wiki · /reset · /quit', ts:Date.now() });
      refresh(); return;
    }
    if (trimmed === '/tools') {
      const tools = engine!.tools.listDefinitions();
      messages.push({ role:'system', text:`${tools.length} tools:\n` + tools.map(t => `  ${fg(P.accent)}${t.name.padEnd(18)}${R} ${t.description}`).join('\n'), ts:Date.now() });
      refresh(); return;
    }
    if (trimmed === '/memory') { engine!.memory.wiki.list().then(p => { messages.push({role:'system',text:`Wiki: ${p.length} pages`,ts:Date.now()}); refresh(); }); return; }
    if (trimmed === '/state') { engine!.memory.loadSessionState().then(s => { messages.push({role:'system',text:s?`Task: ${s.currentTask}\nProgress: ${s.progress}`:'No state yet.',ts:Date.now()}); refresh(); }); return; }
    if (trimmed === '/wiki') { engine!.memory.wiki.list().then(p => { messages.push({role:'system',text:`${p.length} pages:\n`+p.map(x=>`  [[${x.slug}]] — ${x.frontmatter?.title||x.slug}`).join('\n'),ts:Date.now()}); refresh(); }); return; }
    if (trimmed === '/reset') { currentSessionId = engine!.createSession(); messages.push({role:'system',text:`New session: ${currentSessionId}`,ts:Date.now()}); refresh(); return; }

    // ─── LLM ────────────────────────────────────────────────────────

    isProcessing = true;
    messages.push({ role:'user', text:trimmed, ts:Date.now() });
    refresh();
    setStatus(`${fg(P.accent)}⚡${R} ${D}thinking...${R}`);

    loop!.run(currentSessionId, trimmed).then(result => {
      messages.push({ role:'assistant', text:result.response, ts:Date.now(), tokens:result.totalTokens, ms:result.durationMs, tools:result.toolCalls.map(tc=>tc.toolName) });
      isProcessing = false;
      refresh();
      setStatus(` ${fg(P.success)}✓${R} ${D}Ready · ${messages.filter(m=>m.role==='user').length} msgs${R} `);
    }).catch(err => {
      messages.push({ role:'system', text:`${fg(P.error)}Error: ${err instanceof Error ? err.message : String(err)}${R}`, ts:Date.now() });
      isProcessing = false;
      refresh();
      setStatus(` ${fg(P.error)}✗${R} ${D}Error${R} `);
    });
  };

  // Escape key → exit
  (editor as any).onEscape = () => { tui.stop(); process.exit(0); };

  function refresh() {
    logText.setText(renderMessages(messages));
    tui.requestRender();
  }

  function setStatus(s: string) {
    statusText.setText(s);
    tui.requestRender();
  }

  // Start the TUI event loop
  tui.start();

  process.on('SIGINT', () => { tui.stop(); process.exit(0); });
  process.on('SIGTERM', () => { tui.stop(); process.exit(0); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });