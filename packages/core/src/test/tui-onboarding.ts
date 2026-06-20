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

// ─── Name generator ──────────────────────────────────────────────────────
// Procedural unique names: first + last syllable combos.
// Produces ~4,000 pronounceable, memorable names.
// Collision probability at 1,000 deployments: <0.1% (birthday paradox).
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
): Promise<{ workspace: string; agentName: string; userName: string; model: string; provider: string; templates: string[] } | null> {
  const state: OnboardingState = {
    agentName: 'Lodestone',
    userName: 'User',
    templates: ['general'],
    personality: 'balanced',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
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

  // ── Step definitions ────────────────────────────────────────────────────

  const templateOptions = Object.entries(TEMPLATE_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  const personalityOptions = Object.entries(PERSONALITY_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  const providerOptions = Object.entries(PROVIDER_INFO).map(([key, info]) => ({
    key, label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));

  type StepFn = () => Promise<number>;
  const steps: Record<number, StepFn> = {

    // ── Step 0: Welcome ──────────────────────────────────────────────────
    0: async () => {
      await ask(
        `${B}${fg(P.accent)}🔮 Welcome to Lodestone!${R}\n\n` +
        `Lodestone is your personal AI agent — it runs locally, remembers your conversations, and works the way you want it to.\n\n` +
        `I'll ask a few questions to set things up. Nothing is permanent — you can change everything later in your config files.\n\n` +
        `${D}💡 Type "back" at any question to go back to the previous one.${R}\n\n` +
        `Type anything to get started.`,
        'welcome',
        false
      );
      return 1;
    },

    // ── Step 1: Agent name ────────────────────────────────────────────────
    1: async () => {
      const answer = await ask(
        `${B}${fg(P.accent)}What should I call myself?${R}\n\n` +
        `This is my name — I'll use it to introduce myself, sign my work, and address you. Think of it like naming a pet or a project: something you'll want to type and read a lot.\n\n` +
        `Good examples: ${fg(P.success)}Aria${R}, ${fg(P.success)}Atlas${R}, ${fg(P.success)}Nova${R}, ${fg(P.success)}Mochi${R}\n\n` +
        `${D}Type a name, or "surprise me" to generate a unique one.${R}\n\n` +
        `Type a name ${D}(default: ${state.agentName}):${R}`,
        'agent name'
      );
      if (answer === BACK) return 0;
      if (answer && answer.toLowerCase() !== state.agentName.toLowerCase()) {
        if (answer.toLowerCase() === 'surprise me' || answer.toLowerCase() === 'surprise') {
          state.agentName = '__surprise__';  // Sentinel — model picks after boot
          messages.push({ role: 'system', text: `${fg(P.dim)}I'll pick a name for myself once I'm booted up. 🎲${R}`, ts: Date.now() });
          addMessage(messages[messages.length - 1]);
        } else {
          state.agentName = answer;
        }
      }
      return 2;
    },

    // ── Step 2: User name ─────────────────────────────────────────────────
    2: async () => {
      const answer = await ask(
        `${B}${fg(P.accent)}What should I call you?${R}\n\n` +
        `I'll use your name in greetings and when I reference our conversations. First name is fine — whatever feels natural.\n\n` +
        `Type a name ${D}(default: ${state.userName}):${R}`,
        'user name'
      );
      if (answer === BACK) return 1;
      state.userName = answer || state.userName;
      return 3;
    },

    // ── Step 3: Template(s) ───────────────────────────────────────────────
    3: async () => {
      const answer = await askMultiChoice(
        `${B}${fg(P.accent)}What kind of work will we do together?${R}\n\n` +
        `This sets my starting personality, rules, and knowledge areas. Pick one for a focused setup, or combine several — I'll blend them together.\n\n` +
        `You can always add more later by editing the files in your workspace.`,
        templateOptions,
        state.templates.length > 0 ? state.templates : ['general'],
        'focus areas'
      );
      if (answer === BACK) return 2;
      state.templates = (answer as string[]).length > 0 ? (answer as string[]) : ['general'];
      return 4;
    },

    // ── Step 4: Personality ────────────────────────────────────────────────
    4: async () => {
      const answer = await askChoice(
        `${B}${fg(P.accent)}How should I communicate?${R}\n\n` +
        `This controls how wordy I am by default. ${fg(P.success)}Concise${R} for quick answers, ${fg(P.accent)}Balanced${R} for most things, or ${fg(P.info)}Detailed${R} when you want the full picture.\n\n` +
        `Don't overthink it — you can always ask me to adjust on the fly.`,
        personalityOptions,
        'personality'
      );
      if (answer === BACK) return 3;
      state.personality = answer as 'concise' | 'balanced' | 'detailed';
      return 5;
    },

    // ── Step 5: Provider ──────────────────────────────────────────────────
    5: async () => {
      const answer = await askChoice(
        `${B}${fg(P.accent)}Which LLM provider should I use?${R}\n\n` +
        `${fg(P.accent)}Ollama${R} runs models locally on your machine — free, private, no API key needed.\n` +
        `${fg(P.accent)}OpenAI${R} and ${fg(P.accent)}Anthropic${R} use cloud models — faster and smarter, but need API keys and cost money per token.\n\n` +
        `If you're not sure, start with Ollama. You can switch providers anytime in ${D}lodestone.config.yaml${R}.`,
        providerOptions,
        'provider'
      );
      if (answer === BACK) return 4;
      state.provider = answer as 'ollama' | 'openai' | 'anthropic';
      return 6;
    },

    // ── Step 6: Model ──────────────────────────────────────────────────────
    6: async () => {
      const providerHint = state.provider === 'ollama'
        ? 'Make sure you have Ollama running locally with the model pulled.'
        : state.provider === 'openai'
        ? "You'll need an OpenAI API key — set it in your .env file as OPENAI_API_KEY."
        : "You'll need an Anthropic API key — set it in your .env file as ANTHROPIC_API_KEY.";
      const models = PROVIDER_INFO[state.provider].models;
      const modelOptions = models.map((m, i) => ({
        key: m, label: `${m}${i === 0 ? ' (recommended)' : ''}`,
      }));
      const answer = await askChoice(
        `${B}${fg(P.accent)}Which model?${R}\n\n` +
        `The model determines how smart and fast I am. Bigger models are smarter but slower.\n\n` +
        `${D}${providerHint}${R}`,
        modelOptions,
        'model'
      );
      if (answer === BACK) return 5;
      state.model = answer;
      return 7;
    },

    // ── Step 7: Confirm ───────────────────────────────────────────────────
    7: async () => {
      const primaryTemplate = state.templates[0] || 'general';
      const templateInfo = TEMPLATE_INFO[primaryTemplate];
      const providerInfo = PROVIDER_INFO[state.provider];
      const personalityInfo = PERSONALITY_INFO[state.personality];

      const templatesList = state.templates.length > 1
        ? state.templates.map(t => `${TEMPLATE_INFO[t]?.emoji || ''} ${TEMPLATE_INFO[t]?.name || t}`).join(' + ')
        : `${templateInfo.emoji} ${templateInfo.name}`;

      const answer = await ask(
        `${B}${fg(P.accent)}Here's your setup:${R}\n\n` +
        `  ${B}Agent name:${R}   ${state.agentName === '__surprise__' ? fg(P.accent) + '🎲 Model will decide' + R : state.agentName}\n` +
        `  ${B}Your name:${R}     ${state.userName}\n` +
        `  ${B}Focus:${R}        ${templatesList}\n` +
        `  ${B}Personality:${R}  ${personalityInfo.emoji} ${personalityInfo.name}\n` +
        `  ${B}Provider:${R}      ${providerInfo.emoji} ${providerInfo.name}\n` +
        `  ${B}Model:${R}        ${state.model}\n\n` +
        `${D}Type "yes" to create the workspace, "back" to change something, or anything else to cancel.${R}`,
        'confirm',
        true
      );

      if (answer === BACK) return 1;
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        messages.push({ role: 'system', text: `${fg(P.dim)}Setup cancelled. Run Lodestone again to start over.${R}`, ts: Date.now() });
        addMessage(messages[messages.length - 1]);
        updateStatus('error', 'cancelled');
        return -1;
      }
      return 8;
    },
  };

  // ── Run steps ───────────────────────────────────────────────────────────

  let currentStep = 0;
  while (currentStep >= 0 && currentStep <= 7) {
    const nextStep = await steps[currentStep]();
    if (nextStep === -1) return null;
    currentStep = nextStep;
  }

  // ── Create workspace ────────────────────────────────────────────────────

  if (currentStep !== 8) return null;

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

  const nameDisplay = state.agentName === '__surprise__' ? 'Your agent' : state.agentName;
  const nameNote = state.agentName === '__surprise__'
    ? `\n${fg(P.dim)}I'll pick a name for myself once I'm online. 🎲${R}`
    : '';

  await ask(
    `${fg(P.success)}✅ ${nameDisplay} is ready!${R}${nameNote}\n\n` +
    `I've created your workspace at:\n` +
    `  ${D}${state.workspacePath}${R}\n\n` +
    `Your settings are saved in ${D}lodestone.config.yaml${R}. Edit it anytime to change your model, provider, or other settings.\n\n` +
    `API keys go in ${D}.env${R} (already gitignored).\n\n` +
    `${D}Type anything to start chatting.${R}`,
    'ready',
    false
  );

  return {
    workspace: state.workspacePath,
    agentName: state.agentName,
    userName: state.userName,
    model: state.model,
    provider: state.provider,
    templates: state.templates,
  };
}