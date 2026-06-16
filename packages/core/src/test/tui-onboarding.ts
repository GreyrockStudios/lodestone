/**
 * Lodestone — TUI Onboarding
 *
 * Conversational first-time setup that runs inside the TUI.
 * Like setting up a new phone: the agent walks you through it.
 *
 * Flow:
 * 1. Welcome screen
 * 2. "What should I call you?" → agent name
 * 3. "What's your name?" → user name
 * 4. "What kind of work will we do?" → template (multiple choice)
 * 5. "How should I think?" → personality style (concise/detailed/balanced)
 * 6. "Which model?" → LLM provider + model
 * 7. "Where should I live?" → workspace path
 * 8. Review → confirm
 * 9. Create workspace → boot
 *
 * Uses pi-tui overlays for interactive prompts.
 */

import { TUI, ProcessTerminal, Text, Box, Markdown, Editor, Container, Spacer } from '@earendil-works/pi-tui';

import { createWorkspaceFromAnswers } from '../tui-onboarding/workspace-creator.js';
import type { WorkspaceConfig } from '../tui-onboarding/workspace-creator.js';

type InputListenerResult = { consume?: boolean; data?: string } | undefined;

const AVAILABLE_TEMPLATES = ['general', 'developer', 'business', 'creative', 'researcher'] as const;
type TemplateName = typeof AVAILABLE_TEMPLATES[number];

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

// ─── Choice descriptions ────────────────────────────────────────────────────

const TEMPLATE_INFO: Record<string, { emoji: string; name: string; desc: string; soul: string; defaultName: string }> = {
  general: {
    emoji: '🔮',
    name: 'General',
    desc: 'A balanced assistant for everyday tasks. Adaptable, helpful, grounded.',
    soul: 'I\'m {name}. Helpful, adaptable, and grounded. I get things done without overcomplicating.',
    defaultName: 'Lodestone',
  },
  developer: {
    emoji: '💻',
    name: 'Developer',
    desc: 'A coding partner focused on software. Thinks in systems, debugs methodically.',
    soul: 'I\'m {name}. I write clean code, catch bugs before they bite, and think in systems. No fluff — just working software.',
    defaultName: 'Coder',
  },
  business: {
    emoji: '📊',
    name: 'Business',
    desc: 'A strategic advisor for business decisions. Data-driven, concise, revenue-focused.',
    soul: 'I\'m {name}. Strategic, data-driven, and focused on what moves the needle. I cut through noise to find leverage.',
    defaultName: 'Atlas',
  },
  creative: {
    emoji: '🎨',
    name: 'Creative',
    desc: 'A creative collaborator for writing, design, and ideas. Imaginative, expressive.',
    soul: 'I\'m {name}. I think in stories, see patterns others miss, and craft things that resonate. Let\'s make something worth making.',
    defaultName: 'Muse',
  },
  researcher: {
    emoji: '🔬',
    name: 'Researcher',
    desc: 'A research assistant for analysis and synthesis. Thorough, evidence-based, precise.',
    soul: 'I\'m {name}. I follow the evidence, question assumptions, and synthesize across domains. Rigor and curiosity.',
    defaultName: 'Scholar',
  },
};

const PERSONALITY_INFO: Record<string, { emoji: string; name: string; desc: string }> = {
  concise: { emoji: '⚡', name: 'Concise', desc: 'Short, direct answers. No filler. Get to the point.' },
  balanced: { emoji: '⚖️', name: 'Balanced', desc: 'Thoughtful but efficient. Enough detail to be useful, not so much it drowns.' },
  detailed: { emoji: '📖', name: 'Detailed', desc: 'Thorough explanations with context. I\'d rather over-explain than under-explain.' },
};

const PROVIDER_INFO: Record<string, { emoji: string; name: string; models: string[]; desc: string }> = {
  ollama: { emoji: '🦙', name: 'Ollama (local)', models: ['glm-5.1:cloud', 'qwen3:8b', 'llama3:8b', 'mistral:7b'], desc: 'Run models on your own machine. Free, private, no API key needed.' },
  openai: { emoji: '🟢', name: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'], desc: 'Cloud API. Requires OPENAI_API_KEY in environment.' },
  anthropic: { emoji: '🟣', name: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514'], desc: 'Cloud API. Requires ANTHROPIC_API_KEY in environment.' },
};

// ─── Onboarding State ──────────────────────────────────────────────────────

interface OnboardingState {
  step: number;
  agentName: string;
  userName: string;
  template: TemplateName;
  personality: 'concise' | 'balanced' | 'detailed';
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  workspacePath: string;
}

// ─── Step Renderer ─────────────────────────────────────────────────────────

type StepResult = { type: 'next' } | { type: 'back' } | { type: 'quit' } | { type: 'done'; workspace: string };

export async function runOnboarding(tui: TUI, term: ProcessTerminal, suggestedPath: string): Promise<{ workspace: string; agentName: string; userName: string; model: string; provider: string } | null> {
  const state: OnboardingState = {
    step: 0,
    agentName: '',
    userName: '',
    template: 'general',
    personality: 'balanced',
    provider: 'ollama',
    model: 'glm-5.1:cloud',
    workspacePath: suggestedPath,
  };

  const steps = [
    renderWelcome,
    renderAgentName,
    renderUserName,
    renderTemplate,
    renderPersonality,
    renderProvider,
    renderModelSelect,
    renderReview,
  ];

  while (state.step < steps.length) {
    const result = await steps[state.step](tui, term, state);
    if (result.type === 'quit') return null;
    if (result.type === 'back') { state.step = Math.max(0, state.step - 1); continue; }
    if (result.type === 'done') return { workspace: (result as any).workspace, agentName: state.agentName, userName: state.userName, model: state.model, provider: state.provider };
    state.step++;
  }

  // Should not reach here, but just in case
  return null;
}

// ─── Step 0: Welcome ───────────────────────────────────────────────────────

async function renderWelcome(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const content = new Markdown('', 2, 1, mdTheme as any);
    content.setText([
      `${B}${fg(P.accent)}🔮 Lodestone${R}`,
      '',
      'Welcome. Let\'s set up your agent.',
      '',
      'I\'ll walk you through it — just pick what feels right.',
      'You can change everything later in your config files.',
      '',
      `${D}Press Enter to start, or Esc to quit.${R}`,
    ].join('\n'));

    const box = new Box(2, 2, (line: string) => `${bg('#1E232A')}${line}${R}`);
    box.addChild(content);
    const overlay = tui.showOverlay(box, { anchor: 'center', width: 60 });

    const handler = (data: string): InputListenerResult => {
      if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'next' });
      }
      if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'quit' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Helper: Render a choice screen ─────────────────────────────────────────

function renderChoice(
  tui: TUI,
  title: string,
  subtitle: string,
  options: { key: string; label: string; desc: string; emoji: string }[],
  selectedIdx: number,
): { overlay: any; content: Markdown } {
  const lines: string[] = [
    `${B}${fg(P.accent)}${title}${R}`,
    '',
    subtitle,
    '',
  ];

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const isSelected = i === selectedIdx;
    const prefix = isSelected ? `${fg(P.accent)}▸${R} ` : `  `;
    const style = isSelected ? `${B}${fg(P.accent)}` : `${D}`;
    const descStyle = isSelected ? `${fg(P.text)}` : `${D}`;
    lines.push(`${prefix}${opt.emoji} ${style}${opt.label}${R}`);
    lines.push(`    ${descStyle}${opt.desc}${R}`);
    lines.push('');
  }

  lines.push(`${D}↑↓ select  ·  Enter confirm  ·  Esc back${R}`);

  const content = new Markdown('', 2, 1, mdTheme as any);
  content.setText(lines.join('\n'));

  const box = new Box(2, 2, (line: string) => `${bg('#1E232A')}${line}${R}`);
  box.addChild(content);
  const overlay = tui.showOverlay(box, { anchor: 'center', width: 65 });
  return { overlay, content };
}

function updateChoice(
  content: Markdown,
  title: string,
  subtitle: string,
  options: { key: string; label: string; desc: string; emoji: string }[],
  selectedIdx: number,
) {
  const lines: string[] = [
    `${B}${fg(P.accent)}${title}${R}`,
    '',
    subtitle,
    '',
  ];

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const isSelected = i === selectedIdx;
    const prefix = isSelected ? `${fg(P.accent)}▸${R} ` : `  `;
    const style = isSelected ? `${B}${fg(P.accent)}` : `${D}`;
    const descStyle = isSelected ? `${fg(P.text)}` : `${D}`;
    lines.push(`${prefix}${opt.emoji} ${style}${opt.label}${R}`);
    lines.push(`    ${descStyle}${opt.desc}${R}`);
    lines.push('');
  }

  lines.push(`${D}↑↓ select  ·  Enter confirm  ·  Esc back${R}`);
  content.setText(lines.join('\n'));
}

// ─── Step 1: Agent Name ────────────────────────────────────────────────────

async function renderAgentName(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const defaultName = 'Lodestone';
    let currentInput = state.agentName || defaultName;

    const content = new Markdown('', 2, 1, mdTheme as any);
    content.setText([
      `${B}${fg(P.accent)}What should I call myself?${R}`,
      '',
      'This becomes my identity. I\'ll use it when I introduce myself,',
      'sign my work, and talk to you.',
      '',
      `Type a name, or press Enter for **${defaultName}**:`,
      '',
      `${fg(P.accent)}▸ ${B}${currentInput}${R}${fg(P.border)}█${R}`,
      '',
      `${D}Enter confirm  ·  Esc back${R}`,
    ].join('\n'));

    const box = new Box(2, 2, (line: string) => `${bg('#1E232A')}${line}${R}`);
    box.addChild(content);
    const overlay = tui.showOverlay(box, { anchor: 'center', width: 60 });

    const handler = (data: string): InputListenerResult => {
      if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.agentName = currentInput || defaultName;
        overlay.hide();
        resolve({ type: 'next' });
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      } else if (data === '\x7f' || data === '\b') {
        currentInput = currentInput.slice(0, -1) || '';
        content.setText([
          `${B}${fg(P.accent)}What should I call myself?${R}`,
          '', 'This becomes my identity. I\'ll use it when I introduce myself,',
          'sign my work, and talk to you.', '',
          `Type a name, or press Enter for **${defaultName}**:`, '',
          `${fg(P.accent)}▸ ${B}${currentInput}${R}${fg(P.border)}█${R}`, '',
          `${D}Enter confirm  ·  Esc back${R}`,
        ].join('\n'));
        tui.requestRender();
      } else if (data.length === 1 && !data.startsWith('\x1b')) {
        currentInput += data;
        content.setText([
          `${B}${fg(P.accent)}What should I call myself?${R}`,
          '', 'This becomes my identity. I\'ll use it when I introduce myself,',
          'sign my work, and talk to you.', '',
          `Type a name, or press Enter for **${defaultName}**:`, '',
          `${fg(P.accent)}▸ ${B}${currentInput}${R}${fg(P.border)}█${R}`, '',
          `${D}Enter confirm  ·  Esc back${R}`,
        ].join('\n'));
        tui.requestRender();
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 2: User Name ────────────────────────────────────────────────────

async function renderUserName(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    let currentInput = state.userName || '';

    const content = new Markdown('', 2, 1, mdTheme as any);
    content.setText([
      `${B}${fg(P.accent)}And what should I call you?${R}`,
      '',
      `I'm **${state.agentName}**. What's your name?`,
      'I\'ll use it to personalize my responses.',
      '',
      `Type your name:`,
      '',
      `${fg(P.accent)}▸ ${B}${currentInput || '(your name)'}${R}${fg(P.border)}█${R}`,
      '',
      `${D}Enter confirm  ·  Esc back${R}`,
    ].join('\n'));

    const box = new Box(2, 2, (line: string) => `${bg('#1E232A')}${line}${R}`);
    box.addChild(content);
    const overlay = tui.showOverlay(box, { anchor: 'center', width: 60 });

    const handler = (data: string): InputListenerResult => {
      if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.userName = currentInput || 'User';
        overlay.hide();
        resolve({ type: 'next' });
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      } else if (data === '\x7f' || data === '\b') {
        currentInput = currentInput.slice(0, -1);
        content.setText([
          `${B}${fg(P.accent)}And what should I call you?${R}`, '',
          `I'm **${state.agentName}**. What's your name?`,
          'I\'ll use it to personalize my responses.', '',
          `Type your name:`, '',
          `${fg(P.accent)}▸ ${B}${currentInput || '(your name)'}${R}${fg(P.border)}█${R}`, '',
          `${D}Enter confirm  ·  Esc back${R}`,
        ].join('\n'));
        tui.requestRender();
      } else if (data.length === 1 && !data.startsWith('\x1b')) {
        currentInput += data;
        content.setText([
          `${B}${fg(P.accent)}And what should I call you?${R}`, '',
          `I'm **${state.agentName}**. What's your name?`,
          'I\'ll use it to personalize my responses.', '',
          `Type your name:`, '',
          `${fg(P.accent)}▸ ${B}${currentInput || '(your name)'}${R}${fg(P.border)}█${R}`, '',
          `${D}Enter confirm  ·  Esc back${R}`,
        ].join('\n'));
        tui.requestRender();
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 3: Template ──────────────────────────────────────────────────────

async function renderTemplate(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    let selected = AVAILABLE_TEMPLATES.indexOf(state.template);

    const options = AVAILABLE_TEMPLATES.map(t => ({
      key: t,
      label: TEMPLATE_INFO[t].name,
      desc: TEMPLATE_INFO[t].desc,
      emoji: TEMPLATE_INFO[t].emoji,
    }));

    const { overlay, content } = renderChoice(
      tui,
      'What kind of work will we do?',
      `This sets my personality, rules, and focus areas.`,
      options,
      selected,
    );

    const handler = (data: string): InputListenerResult => {
      // Up arrow
      if (data === '\x1b[A' || data === '\x1bOA') {
        selected = Math.max(0, selected - 1);
        updateChoice(content, 'What kind of work will we do?', `This sets my personality, rules, and focus areas.`, options, selected);
        tui.requestRender();
      }
      // Down arrow
      else if (data === '\x1b[B' || data === '\x1bOB') {
        selected = Math.min(options.length - 1, selected + 1);
        updateChoice(content, 'What kind of work will we do?', `This sets my personality, rules, and focus areas.`, options, selected);
        tui.requestRender();
      }
      // Enter
      else if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.template = AVAILABLE_TEMPLATES[selected];
        overlay.hide();
        resolve({ type: 'next' });
      }
      // Escape
      else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 4: Personality ──────────────────────────────────────────────────

async function renderPersonality(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const personalities = ['concise', 'balanced', 'detailed'] as const;
    let selected = personalities.indexOf(state.personality);

    const options = personalities.map(p => ({
      key: p,
      label: PERSONALITY_INFO[p].name,
      desc: PERSONALITY_INFO[p].desc,
      emoji: PERSONALITY_INFO[p].emoji,
    }));

    const { overlay, content } = renderChoice(
      tui,
      'How should I think?',
      `When I respond, should I be brief or thorough?`,
      options,
      selected,
    );

    const handler = (data: string): InputListenerResult => {
      if (data === '\x1b[A' || data === '\x1bOA') {
        selected = Math.max(0, selected - 1);
        updateChoice(content, 'How should I think?', `When I respond, should I be brief or thorough?`, options, selected);
        tui.requestRender();
      } else if (data === '\x1b[B' || data === '\x1bOB') {
        selected = Math.min(options.length - 1, selected + 1);
        updateChoice(content, 'How should I think?', `When I respond, should I be brief or thorough?`, options, selected);
        tui.requestRender();
      } else if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.personality = personalities[selected];
        overlay.hide();
        resolve({ type: 'next' });
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 5: Provider ─────────────────────────────────────────────────────

async function renderProvider(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const providers = ['ollama', 'openai', 'anthropic'] as const;
    let selected = providers.indexOf(state.provider);

    const options = providers.map(p => ({
      key: p,
      label: PROVIDER_INFO[p].name,
      desc: PROVIDER_INFO[p].desc,
      emoji: PROVIDER_INFO[p].emoji,
    }));

    const { overlay, content } = renderChoice(
      tui,
      'How will I think?',
      `Which LLM provider should I use?`,
      options,
      selected,
    );

    const handler = (data: string): InputListenerResult => {
      if (data === '\x1b[A' || data === '\x1bOA') {
        selected = Math.max(0, selected - 1);
        updateChoice(content, 'How will I think?', `Which LLM provider should I use?`, options, selected);
        tui.requestRender();
      } else if (data === '\x1b[B' || data === '\x1bOB') {
        selected = Math.min(options.length - 1, selected + 1);
        updateChoice(content, 'How will I think?', `Which LLM provider should I use?`, options, selected);
        tui.requestRender();
      } else if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.provider = providers[selected];
        // Model will be selected in the next step
        overlay.hide();
        resolve({ type: 'next' });
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 6: Model Selection ──────────────────────────────────────────────

async function renderModelSelect(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const models = PROVIDER_INFO[state.provider].models;
    let selected = models.indexOf(state.model);
    if (selected === -1) selected = 0;

    const options = models.map(m => ({
      key: m,
      label: m,
      desc: m === models[0] ? '(recommended)' : '',
      emoji: '🧠',
    }));

    const { overlay, content } = renderChoice(
      tui,
      'Which model should I use?',
      `${PROVIDER_INFO[state.provider].emoji} ${PROVIDER_INFO[state.provider].name} — pick a model:`,
      options,
      selected,
    );

    const handler = (data: string): InputListenerResult => {
      if (data === '\x1b[A' || data === '\x1bOA') {
        selected = Math.max(0, selected - 1);
        updateChoice(content, 'Which model should I use?', `${PROVIDER_INFO[state.provider].emoji} ${PROVIDER_INFO[state.provider].name} — pick a model:`, options, selected);
        tui.requestRender();
      } else if (data === '\x1b[B' || data === '\x1bOB') {
        selected = Math.min(options.length - 1, selected + 1);
        updateChoice(content, 'Which model should I use?', `${PROVIDER_INFO[state.provider].emoji} ${PROVIDER_INFO[state.provider].name} — pick a model:`, options, selected);
        tui.requestRender();
      } else if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        state.model = models[selected];
        overlay.hide();
        resolve({ type: 'next' });
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

// ─── Step 7: Review ───────────────────────────────────────────────────────

async function renderReview(tui: TUI, term: ProcessTerminal, state: OnboardingState): Promise<StepResult> {
  return new Promise((resolve) => {
    const templateInfo = TEMPLATE_INFO[state.template];
    const personalityInfo = PERSONALITY_INFO[state.personality];
    const providerInfo = PROVIDER_INFO[state.provider];

    const content = new Markdown('', 2, 1, mdTheme as any);
    content.setText([
      `${B}${fg(P.accent)}Here's your agent:${R}`,
      '',
      `${fg(P.accent)}Name:${R}        ${B}${state.agentName}${R}`,
      `${fg(P.accent)}You:${R}          ${B}${state.userName}${R}`,
      `${fg(P.accent)}Template:${R}     ${templateInfo.emoji} ${templateInfo.name}`,
      `${fg(P.accent)}Personality:${R}  ${personalityInfo.emoji} ${personalityInfo.name}`,
      `${fg(P.accent)}Provider:${R}     ${providerInfo.emoji} ${providerInfo.name}`,
      `${fg(P.accent)}Model:${R}        ${state.model}`,
      `${fg(P.accent)}Workspace:${R}    ${state.workspacePath}`,
      '',
      `${D}Everything can be changed later in config files.${R}`,
      '',
      `${fg(P.success)}Enter${R} to create  ·  ${fg(P.dim)}Esc${R} to go back`,
    ].join('\n'));

    const box = new Box(2, 2, (line: string) => `${bg('#1E232A')}${line}${R}`);
    box.addChild(content);
    const overlay = tui.showOverlay(box, { anchor: 'center', width: 60 });

    const handler = (data: string): InputListenerResult => {
      if (data === '\r' || data === '\n') {
        tui.removeInputListener(handler);
        // Create workspace
        try {
          createWorkspaceFromAnswers({
            agentName: state.agentName,
            userName: state.userName,
            template: state.template,
            personality: state.personality,
            provider: state.provider,
            model: state.model,
            workspacePath: state.workspacePath,
          });
          overlay.hide();
          resolve({ type: 'done', workspace: state.workspacePath } as any);
        } catch (err) {
          content.setText(`${fg(P.error)}**Error creating workspace:** ${err instanceof Error ? err.message : String(err)}${R}\n\nPress Esc to go back.`);
          tui.requestRender();
        }
      } else if (data === '\x1b') {
        tui.removeInputListener(handler);
        overlay.hide();
        resolve({ type: 'back' });
      }
      return undefined;
    };
    tui.addInputListener((data: string) => { handler(data); return { consume: true }; });
    tui.requestRender();
  });
}

