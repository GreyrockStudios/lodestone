/**
 * Lodestone — TUI Slash Commands
 *
 * All /command handlers for the TUI chat interface.
 * Extracted from tui-chat.ts for cleaner separation.
 */

import { Theme, fg, R, B, D } from './theme.js';
import { ChatMessage, formatDuration } from './messages.js';
import { buildImproveDashboard } from './dashboard.js';
import type { CapabilityManager } from '../safety/capability-tiers.js';
import type { BehavioralLearning } from '../safety/behavioral-learning.js';

export interface CommandContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI engine type varies
  engine: any;
  messages: ChatMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity loaded at runtime
  identity: any;
  displayName: string;
  model: string;
  scrollOffset: number;
  theme: Theme;
  capabilities?: CapabilityManager;
  behavioralLearning?: BehavioralLearning;
  refreshAll: () => void;
  updateStatus: (state: 'ready' | 'thinking' | 'tool' | 'streaming' | 'error' | 'setup', detail?: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onboarding returns vary
  runOnboarding: () => Promise<any>;
  createSession: () => string;
  setTheme: (name: string) => void;
  cleanup: () => void;
}

export interface CommandResult {
  handled: boolean;
  newSessionId?: string;
  themeChanged?: string;
}

/**
 * Handle a slash command. Returns true if the command was handled.
 */
export async function handleCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const P = ctx.theme?.colors ?? {
    success: '#7DD3A5', error: '#DC2626', warn: '#FBBF24', info: '#60A5FA',
    tool: '#F6C453', code: '#F0C987', purple: '#A78BFA', pink: '#F472B6',
    dim: '#7B7F87', accent: '#F6C453',
  };

  switch (cmd) {
    case '/help':
      ctx.messages.push({ role: 'system', text: [
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
        '  /theme [name] — Show/set theme (dark, midnight, forest, light, cyber)',
        '  /capabilities — Show tool capability tiers',
        '  /rules — Show learned behavioral rules',
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
      ctx.refreshAll();
      return { handled: true };

    case '/tools': {
      const tools = ctx.engine.tools.listDefinitions();
      ctx.messages.push({ role: 'system', text: `**${tools.length} tools:**\n` + tools.map((t: { name: string; description: string }) => `- \`${t.name}\` — ${t.description}`).join('\n'), ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/memory': {
      const pages = await ctx.engine.memory.wiki.list();
      ctx.messages.push({ role: 'system', text: `**Wiki:** ${pages.length} pages`, ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/state': {
      const state = await ctx.engine.memory.loadSessionState();
      ctx.messages.push({ role: 'system', text: state ? `**Task:** ${state.currentTask}\n**Progress:** ${state.progress}` : 'No state yet.', ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/wiki': {
      const pages = await ctx.engine.memory.wiki.list();
      ctx.messages.push({ role: 'system', text: `**${pages.length} pages:**\n` + pages.map((x: { slug: string; frontmatter?: { title?: string } }) => `- [[${x.slug}]] — ${x.frontmatter?.title || x.slug}`).join('\n'), ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/improve': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- theme not in CommandContext type
      const theme = (ctx as any).theme;
      const dashboard = await buildImproveDashboard(ctx.engine, theme);
      ctx.messages.push({ role: 'system', text: dashboard, ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/predict': {
      const predictText = args.join(' ');
      const predictParts = predictText.split('|').map(s => s.trim());
      if (predictParts.length < 3) {
        ctx.messages.push({ role: 'system', text: `${fg(P.warn)}Usage: /predict <task> | <expected outcome> | <confidence 0-1>${R}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      const [task, expected, confStr] = predictParts;
      const confidence = parseFloat(confStr);
      if (isNaN(confidence) || confidence < 0 || confidence > 1) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Confidence must be 0-1${R}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      try {
        const pred = await ctx.engine.improvement.predictionJournal.predict(
          task, expected, confidence,
          new Date(Date.now() + 86400000).toISOString(),
          ['tui']
        );
        ctx.messages.push({ role: 'system', text: `${fg(P.success)}✓${R} Prediction logged: \`${pred.id}\`\n**Task:** ${task}\n**Expected:** ${expected}\n**Confidence:** ${(confidence * 100).toFixed(0)}%\nResolve with: ask me "resolve prediction ${pred.id} as <outcome>"`, ts: Date.now() });
      } catch (e: unknown) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Error: ${e instanceof Error ? e.message : String(e)}${R}`, ts: Date.now() });
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/rbt': {
      const activities = ctx.messages
        .filter(m => m.role === 'assistant' || m.role === 'user')
        .slice(-10)
        .map(m => ({
          action: m.text.slice(0, 80),
          timestamp: new Date(m.ts).toISOString(),
          outcome: (m.role === 'assistant' ? 'success' : 'partial') as 'success' | 'partial',
          category: 'conversation' as string,
        }));
      if (activities.length === 0) {
        activities.push({ action: 'Started TUI session', timestamp: new Date().toISOString(), outcome: 'success' as const, category: 'system' });
      }
      try {
        const report = await ctx.engine.improvement.rbtDiagnosis.diagnose(activities);
        const lines = [
          `${B}${fg(P.success)}🌹 RBT Diagnosis${R}`,
          `**Roses (${report.roses.length}):** ${report.roses.map((r: { action?: string; description?: string }) => r.action || r.description || 'unknown').join(', ') || 'none'}`,
          `**Buds (${report.buds.length}):** ${report.buds.map((b: { action?: string; description?: string }) => b.action || b.description || 'unknown').join(', ') || 'none'}`,
          `**Thorns (${report.thorns.length}):** ${report.thorns.map((t: { action?: string; description?: string }) => t.action || t.description || 'unknown').join(', ') || 'none'}`,
          `**Summary:** ${report.summary}`,
        ];
        ctx.messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
      } catch (e: unknown) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}RBT Error: ${e instanceof Error ? e.message : String(e)}${R}`, ts: Date.now() });
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/drift': {
      try {
        const rules = ctx.identity.rules?.raw || 'No rules loaded';
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

        const decisions = ctx.messages
          .filter(m => m.role === 'assistant')
          .slice(-5)
          .map(m => ({
            decision: m.text.slice(0, 80),
            rationale: 'TUI conversation',
            timestamp: new Date(m.ts).toISOString(),
            tags: ['conversation'],
          }));

        const report = await ctx.engine.improvement.driftDetector.check(identityRules, decisions.length > 0 ? decisions : [{
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
          lines.push('**Deviations:**');
          for (const f of report.flagged.slice(0, 5)) {
            lines.push(`  - ${fg(P.error)}${f.rule}${R}: ${f.reasoning || ''}`);
          }
        }
        if (report.suggestions && report.suggestions.length > 0) {
          lines.push('**Suggestions:**');
          for (const s of report.suggestions.slice(0, 3)) {
            lines.push(`  - ${s}`);
          }
        }
        ctx.messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
      } catch (e: unknown) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Drift Error: ${e instanceof Error ? e.message : String(e)}${R}`, ts: Date.now() });
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/lessons': {
      try {
        const lessons = await ctx.engine.improvement.skillEvolver.listLessons({ limit: 20 });
        const skills = await ctx.engine.improvement.skillEvolver.listSkills();
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
        ctx.messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
      } catch (e: unknown) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Lessons Error: ${e instanceof Error ? e.message : String(e)}${R}`, ts: Date.now() });
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/sleep': {
      ctx.messages.push({ role: 'system', text: `${fg(P.info)}🌙 Running sleep cycle...${R}`, ts: Date.now() });
      ctx.refreshAll();
      ctx.updateStatus('thinking', 'sleep cycle');
      try {
        const result = await ctx.engine.improvement.sleepCycle.runFullCycle();
        const lines = [
          `${B}${fg(P.info)}🌙 Sleep Cycle Complete${R} (${formatDuration(result.durationMs)})`,
          `**Harvest:** ${result.harvest ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
          `**Mine:** ${result.mine ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
          `**Reflect:** ${result.reflect ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
          `**Consolidate:** ${result.consolidate ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
          `**Validate:** ${result.validate ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
          `**Prepare:** ${result.prepare ? `${fg(P.success)}✓${R}` : `${D}—${R}`}`,
        ];
        if (result.errors.length > 0) {
          lines.push(`${fg(P.warn)}⚠ ${result.errors.length} errors${R}`);
        }
        ctx.messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
        ctx.updateStatus('ready');
      } catch (e: unknown) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Sleep Error: ${e instanceof Error ? e.message : String(e)}${R}`, ts: Date.now() });
        ctx.updateStatus('error');
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/theme': {
      const { THEME_NAMES } = await import('./theme.js');
      const themeName = args[0]?.toLowerCase();
      if (!themeName) {
        // Show current theme and available themes
        const current = ctx.theme.name;
        const available = THEME_NAMES.map(n => n === current ? `${B}${fg(P.accent)}${n} (current)${R}` : n).join(', ');
        ctx.messages.push({ role: 'system', text: `${B}${fg(P.accent)}🎨 Themes${R}\nCurrent: ${B}${current}${R}\nAvailable: ${available}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      if (!THEME_NAMES.includes(themeName)) {
        ctx.messages.push({ role: 'system', text: `${fg(P.error)}Unknown theme: ${themeName}${R}\nAvailable: ${THEME_NAMES.join(', ')}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      return { handled: true, themeChanged: themeName };
    }

    case '/channels': {
      if (!ctx.engine.channelManager || !ctx.engine.channelManager.isRunning()) {
        ctx.messages.push({ role: 'system', text: `${D}No channels configured or running.${R}\n\nTo enable channels, add them to your config:\n${fg(P.code)}channels:\n  telegram:\n    enabled: true\n    botToken: \${TELEGRAM_BOT_TOKEN}${R}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      const channels = ctx.engine.channelManager.listChannels();
      const lines = [
        `${B}${fg(P.info)}📡 Channels${R}`,
        `${channels.length} channel(s) active:`,
      ];
      for (const ch of channels) {
        lines.push(`  ${fg(P.success)}✓${R} ${ch.name} (${ch.id})`);
      }
      ctx.messages.push({ role: 'system', text: lines.join('\n'), ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/setup': {
      ctx.messages.push({ role: 'system', text: `${fg(P.info)}Restarting setup...${R}\nType anything to begin.`, ts: Date.now() });
      ctx.refreshAll();
      const setupResult = await ctx.runOnboarding();
      if (setupResult) {
        ctx.updateStatus('setup', 'workspace created');
        ctx.messages.push({ role: 'system', text: `${fg(P.success)}Setup complete!${R} Restart to apply all changes.`, ts: Date.now() });
      }
      ctx.refreshAll();
      return { handled: true };
    }

    case '/capabilities': {
      if (!ctx.capabilities) {
        ctx.messages.push({ role: 'system', text: `${fg(P.warn)}Capability tiers not available${R}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      const summary = ctx.capabilities.getTierSummary();
      const capLines = [
        `${B}${fg(P.accent)}🛡️ Capability Tiers${R}`,
      ];
      for (const [tier, info] of Object.entries(summary)) {
        const icon = tier === 'public' ? `${fg(P.success)}✓${R}` : tier === 'controlled' ? `${fg(P.info)}◆${R}` : tier === 'restricted' ? `${fg(P.warn)}▲${R}` : `${fg(P.error)}●${R}`;
        const tools = info.tools.length > 0 ? info.tools.join(', ') : '(none)';
        capLines.push(`  ${icon} ${B}${tier}${R} (${info.count}) — ${tools}`);
      }
      ctx.messages.push({ role: 'system', text: capLines.join('\n'), ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/rules': {
      if (!ctx.behavioralLearning) {
        ctx.messages.push({ role: 'system', text: `${fg(P.warn)}Behavioral learning not available${R}`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      const rules = ctx.behavioralLearning.getActiveRules();
      const stats = ctx.behavioralLearning.getStats();
      if (rules.length === 0) {
        ctx.messages.push({ role: 'system', text: `${B}${fg(P.accent)}📚 Behavioral Rules${R}\nNo rules learned yet. Rules are extracted from user corrections.`, ts: Date.now() });
        ctx.refreshAll();
        return { handled: true };
      }
      const ruleLines = [
        `${B}${fg(P.accent)}📚 Behavioral Rules${R} (${stats.active} active, avg confidence ${(stats.avgConfidence * 100).toFixed(0)}%)`,
      ];
      for (const rule of rules.slice(0, 15)) {
        const conf = `${fg(rule.confidence >= 0.8 ? P.success : rule.confidence >= 0.5 ? P.warn : P.error)}${(rule.confidence * 100).toFixed(0)}%${R}`;
      const source = rule.source === 'explicit-correction' ? '📌' : rule.source === 'implicit-correction' ? '💡' : rule.source === 'manual' ? '✍️' : '🔄';
        ruleLines.push(`  ${source} ${conf} When ${rule.trigger}, ${rule.correctBehavior}${rule.incorrectBehavior ? ` (not ${rule.incorrectBehavior})` : ''}`);
      }
      if (rules.length > 15) {
        ruleLines.push(`  ${D}... and ${rules.length - 15} more${R}`);
      }
      ctx.messages.push({ role: 'system', text: ruleLines.join('\n'), ts: Date.now() });
      ctx.refreshAll();
      return { handled: true };
    }

    case '/reset': {
      const newId = ctx.createSession();
      ctx.messages.push({ role: 'system', text: `New session: \`${newId}\``, ts: Date.now() });
      ctx.refreshAll();
      return { handled: true, newSessionId: newId };
    }

    case '/quit':
    case '/exit':
      ctx.cleanup();
      return { handled: true };

    default:
      return { handled: false };
  }
}