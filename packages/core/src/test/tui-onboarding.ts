/**
 * Lodestone — Conversational Onboarding
 *
 * Chat-based setup that uses the TUI's existing message system.
 * No overlays or custom key handling — just conversation.
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

// ─── Conversational Onboarding ─────────────────────────────────────────────

export async function runOnboarding(
  messages: ChatMessage[],
  addMessage: (msg: ChatMessage) => void,
  editor: any,
  refreshAll: () => void,
  updateStatus: (status: string, detail?: string) => void,
  suggestedPath: string,
): Promise<{ workspace: string; agentName: string; userName: string; model: string; provider: string } | null> {
  const state: OnboardingState = {
    agentName: '',
    userName: '',
    templates: ['general'],
    personality: 'balanced',
    provider: 'ollama',
    model: 'glm-5.1:cloud',
    workspacePath: suggestedPath,
  };

  // Wait for user input via the editor
  const ask = (prompt: string, statusLabel?: string): Promise<string> => new Promise((resolve) => {
    messages.push({ role: 'assistant', text: prompt, ts: Date.now() });
    addMessage(messages[messages.length - 1]);
    if (statusLabel) updateStatus('setup', statusLabel);
    const saved = editor.onSubmit;
    editor.onSubmit = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      editor.setText('');
      editor.onSubmit = saved;
      resolve(trimmed);
    };
  });

  // Ask for a choice — accepts number or name
  const askChoice = async (prompt: string, options: { key: string; label: string }[]): Promise<string> => {
    const optionLines = options.map((o, i) => `  ${B}${i + 1}.${R} ${o.label}`).join('\n');
    const answer = await ask(`${prompt}\n\n${optionLines}\n\n${D}Type a number or name:${R}`);
    
    const num = parseInt(answer);
    if (num >= 1 && num <= options.length) return options[num - 1].key;
    const keyMatch = options.find(o => o.key.toLowerCase() === answer.toLowerCase());
    if (keyMatch) return keyMatch.key;
    const labelMatch = options.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
    if (labelMatch) return labelMatch.key;
    return options[0].key;
  };

  // Ask for multiple choices — accepts comma-separated numbers or names
  const askMultiChoice = async (prompt: string, options: { key: string; label: string }[], defaults: string[]): Promise<string[]> => {
    const optionLines = options.map((o, i) => `  ${B}${i + 1}.${R} ${o.label}`).join('\n');
    const defaultStr = defaults.map(d => {
      const idx = options.findIndex(o => o.key === d);
      return idx >= 0 ? String(idx + 1) : d;
    }).join(', ');
    const answer = await ask(`${prompt}\n\n${optionLines}\n\n${D}Type numbers or names, comma-separated (default: ${defaultStr}):${R}`);
    
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

  // Step 0: Welcome
  await ask(
    `${B}${fg(P.accent)}🔮 Welcome to Lodestone!${R}\n\n` +
    `I'll help you set up your agent. Just answer a few questions — you can change everything later in your config files.\n\n` +
    `Type anything to continue.`,
    'welcome'
  );

  // Step 1: Agent name
  state.agentName = await ask(
    `${B}${fg(P.accent)}What should I call myself?${R}\n\n` +
    `This becomes my identity. I'll use it when I introduce myself, sign my work, and talk to you.\n\n` +
    `Type a name ${D}(default: Lodestone):${R}`,
    'agent name'
  ) || 'Lodestone';

  // Step 2: User name
  state.userName = await ask(
    `${B}${fg(P.accent)}What should I call you?${R}\n\n` +
    `I'll use this when I greet you and reference our conversations.\n\n` +
    `Type a name ${D}(default: User):${R}`,
    'user name'
  ) || 'User';

  // Step 3: Template(s) — multiple selection
  const templateOptions = Object.entries(TEMPLATE_INFO).map(([key, info]) => ({
    key,
    label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  state.templates = await askMultiChoice(
    `${B}${fg(P.accent)}What kind of work will we do?${R}\n\nYou can pick more than one — I'll blend them together.`,
    templateOptions,
    ['general'],
  );
  // Use the first template as primary, others influence personality
  state.templates = state.templates.length > 0 ? state.templates : ['general'];

  // Step 4: Personality
  const personalityOptions = Object.entries(PERSONALITY_INFO).map(([key, info]) => ({
    key,
    label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  state.personality = (await askChoice(
    `${B}${fg(P.accent)}How should I communicate?${R}`,
    personalityOptions,
  )) as 'concise' | 'balanced' | 'detailed';

  // Step 5: Provider
  const providerOptions = Object.entries(PROVIDER_INFO).map(([key, info]) => ({
    key,
    label: `${info.emoji} ${info.name} — ${info.desc}`,
  }));
  state.provider = (await askChoice(
    `${B}${fg(P.accent)}Which LLM provider?${R}`,
    providerOptions,
  )) as 'ollama' | 'openai' | 'anthropic';

  // Step 6: Model
  const models = PROVIDER_INFO[state.provider].models;
  const modelOptions = models.map((m, i) => ({
    key: m,
    label: `${m}${i === 0 ? ' (recommended)' : ''}`,
  }));
  state.model = await askChoice(
    `${B}${fg(P.accent)}Which model?${R}`,
    modelOptions,
  );

  // Step 7: Confirm
  const primaryTemplate = state.templates[0];
  const templateInfo = TEMPLATE_INFO[primaryTemplate];
  const providerInfo = PROVIDER_INFO[state.provider];
  const personalityInfo = PERSONALITY_INFO[state.personality];
  
  const templatesList = state.templates.length > 1
    ? state.templates.map(t => `${TEMPLATE_INFO[t]?.emoji || ''} ${TEMPLATE_INFO[t]?.name || t}`).join(' + ')
    : `${templateInfo.emoji} ${templateInfo.name}`;

  const confirm = await ask(
    `${B}${fg(P.accent)}Here's your setup:${R}\n\n` +
    `  ${B}Agent name:${R}   ${state.agentName}\n` +
    `  ${B}Your name:${R}     ${state.userName}\n` +
    `  ${B}Focus:${R}        ${templatesList}\n` +
    `  ${B}Personality:${R}  ${personalityInfo.emoji} ${personalityInfo.name}\n` +
    `  ${B}Provider:${R}      ${providerInfo.emoji} ${providerInfo.name}\n` +
    `  ${B}Model:${R}        ${state.model}\n\n` +
    `${D}Type yes to create, or anything else to cancel:${R}`,
    'confirm'
  );

  if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
    return null;
  }

  // Create workspace
  try {
    createWorkspaceFromAnswers({
      agentName: state.agentName,
      userName: state.userName,
      template: primaryTemplate as any,
      personality: state.personality,
      provider: state.provider,
      model: state.model,
      workspacePath: state.workspacePath,
    });
  } catch (err: any) {
    await ask(`${fg(P.error)}Error creating workspace: ${err.message}${R}`, 'error');
    return null;
  }

  await ask(
    `${fg(P.success)}✅ Workspace created!${R}\n\n` +
    `Your workspace is at ${D}${state.workspacePath}${R}\n` +
    `Config saved to ${D}lodestone.config.yaml${R}\n\n` +
    `Type anything to start chatting.`,
    'ready'
  );

  return {
    workspace: state.workspacePath,
    agentName: state.agentName,
    userName: state.userName,
    model: state.model,
    provider: state.provider,
  };
}