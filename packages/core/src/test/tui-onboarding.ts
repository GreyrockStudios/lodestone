/**
 * Lodestone — Conversational Onboarding
 *
 * Chat-based setup with back navigation. Type "back" at any step to go back.
 * Templates support multiple selections.
 */

import { createWorkspaceFromAnswers, TEMPLATE_INFO, PROVIDER_INFO, PERSONALITY_INFO } from '../tui-onboarding/workspace-creator.js';
import type { WorkspaceConfig } from '../tui-onboarding/workspace-creator.js';

// ─── Colors (OpenClaw dark palette) ────────────────────────────────────────

const P = {
  text: '#E8E3D5', dim: '#7B7F87', accent: '#F6C453', accent2: '#F2A65A',
  border: '#3C414B', userBg: '#2B2F36', userText: '#F3EEE0', sysText: '#9BA3B2',
  tool: '#F6C453', code: '#F0C987', error: '#DC2626', success: '#7DD3A5',
  quote: '#8CC8FF', quoteBorder: '#3B4D6B', warn: '#FBBF24', info: '#60A5FA',
  purple: '#A78BFA', pink: '#F472B6',
};
const R = '\x1B[0m'; const B = '\x1B[1m'; const D = '\x1B[2m'; const I = '\x1B[3m';
function fg(c: string) { return `\x1B[38;2;${parseInt(c.slice(1,3),16)};${parseInt(c.slice(3,5),16)};${parseInt(c.slice(5,7),16)}m`; }

const BACK = Symbol('back');

// ─── Types ─────────────────────────────────────────────────────────────────

interface OnboardingState {
  agentName: string;
  userName: string;
  templates: string[];
  personality: 'concise' | 'balanced' | 'detailed';
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  workspacePath: string;
}

type ChatMessage = { role: 'user' | 'assistant' | 'system' | 'tool'; text: string; ts: number };
type StatusType = 'ready' | 'thinking' | 'tool' | 'streaming' | 'error' | 'setup';

// ─── Conversational Onboarding ─────────────────────────────────────────────

export async function runOnboarding(
  messages: ChatMessage[],
  addMessage: (msg: ChatMessage) => void,
  editor: any,
  refreshAll: () => void,
  updateStatus: (status: StatusType, detail?: string) => void,
  suggestedPath: string,
): Promise<{ workspace: string; agentName: string; userName: string; model: string; provider: string } | null> {
  const state: OnboardingState = {
    agentName: 'Lodestone',
    userName: 'User',
    templates: ['general'],
    personality: 'balanced',
    provider: 'ollama',
    model: 'glm-5.1:cloud',
    workspacePath: suggestedPath,
  };

  // ── Input helpers ───────────────────────────────────────────────────────

  const ask = (prompt: string, statusLabel?: string, canGoBack = true): Promise<string | typeof BACK> => new Promise((resolve) => {
    messages.push({ role: 'assistant', text: prompt, ts: Date.now() });
    addMessage(messages[messages.length - 1]);
    if (statusLabel) updateStatus('setup', statusLabel);
    const saved = editor.onSubmit;
    editor.onSubmit = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (canGoBack && (lower === 'back' || lower === 'b')) {
        editor.setText('');
        editor.onSubmit = saved;
        resolve(BACK);
        return;
      }
      editor.setText('');
      editor.onSubmit = saved;
      resolve(trimmed);
    };
  });

  const askChoice = async (
    prompt: string, options: { key: string; label: string }[], statusLabel?: string
  ): Promise<string | typeof BACK> => {
    const backHint = `${D}Type a number, name, or "back" to go back.${R}`;
    const optionLines = options.map((o, i) => `  ${B}${i + 1}.${R} ${o.label}`).join('\n');
    const answer = await ask(`${prompt}\n\n${optionLines}\n\n${backHint}`, statusLabel);
    if (answer === BACK) return BACK;

    const num = parseInt(answer);
    if (num >= 1 && num <= options.length) return options[num - 1].key;
    const keyMatch = options.find(o => o.key.toLowerCase() === answer.toLowerCase());
    if (keyMatch) return keyMatch.key;
    const labelMatch = options.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
    if (labelMatch) return labelMatch.key;
    return options[0].key;
  };

  const askMultiChoice = async (
    prompt: string, options: { key: string; label: string }[], defaults: string[], statusLabel?: string
  ): Promise<string[] | typeof BACK> => {
    const optionLines = options.map((o, i) => `  ${B}${i + 1}.${R} ${o.label}`).join('\n');
    const defaultStr = defaults.map(d => {
      const idx = options.findIndex(o => o.key === d);
      return idx >= 0 ? String(idx + 1) : d;
    }).join(', ');
    const answer = await ask(
      `${prompt}\n\n${optionLines}\n\n${D}Type numbers or names, comma-separated (default: ${defaultStr}). Or "back" to go back.${R}`,
      statusLabel
    );
    if (answer === BACK) return BACK;
    if (!answer || answer.toLowerCase() === 'all') return options.map(o => o.key);

    const parts = answer.split(/[,\s]+/).filter(Boolean);
    const results: string[] = [];
    for (const part of parts) {
      const num = parseInt(part);
      if (num >= 1 && num <= options.length) {
        results.push(options[num - 1].key);
      } else {
        const keyMatch = options.find(o => o.key.toLowerCase() === part.toLowerCase());
        if (keyMatch) results.push(keyMatch.key);
        else {
          const labelMatch = options.find(o => o.label.toLowerCase().includes(part.toLowerCase()));
          if (labelMatch) results.push(labelMatch.key);
        }
      }
    }
    return results.length > 0 ? [...new Set(results)] : defaults;
  };

  // ── Step definitions (each returns step number to go to, or -1 to cancel) ─

  const templateOptions = Object.entries(TEMPLATE_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  const personalityOptions = Object.entries(PERSONALITY_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  const providerOptions = Object.entries(PROVIDER_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));

  type StepFn = () => Promise<number>;  // returns next step, or -1 to cancel

  const steps: Record<number, StepFn> = {
    0: async () => {
      // Welcome — can't go back
      await ask(
        `${B}${fg(P.accent)}🔮 Welcome to Lodestone!${R}\n\n` +
        `I'll help you set up your agent. Just answer a few questions — you can change everything later in your config files.\n\n` +
        `${D}Type "back" at any step to go back. Type anything to continue.${R}`,
        'welcome',
        false
      );
      return 1;
    },

    1: async () => {
      const answer = await ask(
        `${B}${fg(P.accent)}What should I call myself?${R}\n\n` +
        `This becomes my identity. I'll use it when I introduce myself, sign my work, and talk to you.\n\n` +
        `Type a name ${D}(default: ${state.agentName}):${R}`,
        'agent name'
      );
      if (answer === BACK) return 0;
      state.agentName = answer || state.agentName;
      return 2;
    },

    2: async () => {
      const answer = await ask(
        `${B}${fg(P.accent)}What should I call you?${R}\n\n` +
        `I'll use this when I greet you and reference our conversations.\n\n` +
        `Type a name ${D}(default: ${state.userName}):${R}`,
        'user name'
      );
      if (answer === BACK) return 1;
      state.userName = answer || state.userName;
      return 3;
    },

    3: async () => {
      const answer = await askMultiChoice(
        `${B}${fg(P.accent)}What kind of work will we do?${R}\n\nYou can pick more than one — I'll blend them together.`,
        templateOptions,
        state.templates.length > 0 ? state.templates : ['general'],
        'focus areas'
      );
      if (answer === BACK) return 2;
      state.templates = (answer as string[]).length > 0 ? (answer as string[]) : ['general'];
      return 4;
    },

    4: async () => {
      const answer = await askChoice(
        `${B}${fg(P.accent)}How should I communicate?${R}`,
        personalityOptions,
        'personality'
      );
      if (answer === BACK) return 3;
      state.personality = answer as 'concise' | 'balanced' | 'detailed';
      return 5;
    },

    5: async () => {
      const answer = await askChoice(
        `${B}${fg(P.accent)}Which LLM provider?${R}`,
        providerOptions,
        'provider'
      );
      if (answer === BACK) return 4;
      state.provider = answer as 'ollama' | 'openai' | 'anthropic';
      return 6;
    },

    6: async () => {
      const models = PROVIDER_INFO[state.provider].models;
      const modelOptions = models.map((m, i) => ({
        key: m, label: `${m}${i === 0 ? ' (recommended)' : ''}`,
      }));
      const answer = await askChoice(
        `${B}${fg(P.accent)}Which model?${R}`,
        modelOptions,
        'model'
      );
      if (answer === BACK) return 5;
      state.model = answer;
      return 7;
    },

    7: async () => {
      // Confirm
      const primaryTemplate = state.templates[0] || 'general';
      const templateInfo = TEMPLATE_INFO[primaryTemplate];
      const providerInfo = PROVIDER_INFO[state.provider];
      const personalityInfo = PERSONALITY_INFO[state.personality];

      const templatesList = state.templates.length > 1
        ? state.templates.map(t => `${TEMPLATE_INFO[t]?.emoji || ''} ${TEMPLATE_INFO[t]?.name || t}`).join(' + ')
        : `${templateInfo.emoji} ${templateInfo.name}`;

      const answer = await ask(
        `${B}${fg(P.accent)}Here's your setup:${R}\n\n` +
        `  ${B}Agent name:${R}   ${state.agentName}\n` +
        `  ${B}Your name:${R}     ${state.userName}\n` +
        `  ${B}Focus:${R}        ${templatesList}\n` +
        `  ${B}Personality:${R}  ${personalityInfo.emoji} ${personalityInfo.name}\n` +
        `  ${B}Provider:${R}      ${providerInfo.emoji} ${providerInfo.name}\n` +
        `  ${B}Model:${R}        ${state.model}\n\n` +
        `${D}Type "yes" to create, "back" to change something, or anything else to cancel:${R}`,
        'confirm',
        true
      );

      if (answer === BACK) return 1;  // Go back to step 1 with current values as defaults
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        // Cancel
        messages.push({ role: 'system', text: `${fg(P.dim)}Setup cancelled. Run Lodestone again to start over.${R}`, ts: Date.now() });
        addMessage(messages[messages.length - 1]);
        updateStatus('error', 'cancelled');
        return -1;
      }
      return 8; // Create workspace
    },
  };

  // ── Run steps ───────────────────────────────────────────────────────────

  let currentStep = 0;
  while (currentStep >= 0 && currentStep <= 7) {
    const nextStep = await steps[currentStep]();
    if (nextStep === -1) return null;  // Cancelled
    currentStep = nextStep;
  }

  // ── Create workspace ────────────────────────────────────────────────────

  if (currentStep !== 8) return null;  // Shouldn't happen but safety check

  updateStatus('setup', 'creating workspace');
  try {
    createWorkspaceFromAnswers({
      agentName: state.agentName,
      userName: state.userName,
      template: (state.templates[0] || 'general') as any,
      templates: state.templates,
      personality: state.personality,
      provider: state.provider,
      model: state.model,
      workspacePath: state.workspacePath,
    });
  } catch (err: any) {
    messages.push({ role: 'system', text: `${fg(P.error)}Error creating workspace: ${err.message}${R}\n\nCheck the path and permissions, then try again.`, ts: Date.now() });
    addMessage(messages[messages.length - 1]);
    updateStatus('error', 'workspace error');
    return null;
  }

  // ── Done ────────────────────────────────────────────────────────────────

  await ask(
    `${fg(P.success)}✅ Workspace created!${R}\n\n` +
    `${B}${state.agentName}${R} is ready to go.\n\n` +
    `Workspace: ${D}${state.workspacePath}${R}\n` +
    `Config: ${D}lodestone.config.yaml${R}\n\n` +
    `Type anything to start chatting.`,
    'ready',
    false
  );

  return {
    workspace: state.workspacePath,
    agentName: state.agentName,
    userName: state.userName,
    model: state.model,
    provider: state.provider,
  };
}