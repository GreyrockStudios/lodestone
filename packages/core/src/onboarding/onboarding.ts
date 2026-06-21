/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Onboarding Wizard
 *
 * Robust readline-based onboarding with validation, defaults, back navigation,
 * multi-select, Ctrl+C partial-save, and non-interactive mode for CI/Docker.
 *
 * No external dependencies — uses only Node.js built-in modules.
 */

import { createInterface, type Interface as RLInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createWorkspaceFromAnswers, TEMPLATE_INFO, PROVIDER_INFO, PERSONALITY_INFO, type WorkspaceConfig } from '../tui-onboarding/workspace-creator.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OnboardingAnswers {
  agentName: string;
  userName: string;
  templates: string[];
  personality: 'concise' | 'balanced' | 'detailed';
  provider: 'ollama' | 'openai' | 'anthropic';
  model: string;
  workspacePath: string;
}

export interface NonInteractiveOptions {
  template?: string;
  provider?: string;
  model?: string;
  agentName?: string;
  userName?: string;
  personality?: string;
  workspacePath?: string;
}

type PromptResult = string | '__back__' | '__quit__';

// ─── Onboarding Wizard ──────────────────────────────────────────────────────

export class OnboardingWizard {
  private rl: RLInterface;
  private logger = getLogger('onboarding');
  private currentStep = 0;
  private totalSteps = 5;
  private answers: Partial<OnboardingAnswers> = {};
  private partialSavePath: string;

  constructor(partialSavePath?: string) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    this.partialSavePath = partialSavePath || resolve(process.cwd(), '.lodestone-onboarding-partial.json');

    // Handle Ctrl+C — save partial progress
    this.rl.on('SIGINT', () => {
      this.savePartialProgress();
      console.log('\n\n⚠️  Onboarding interrupted. Partial progress saved.');
      console.log(`   Resume with: lodestone init --resume`);
      this.rl.close();
      process.exit(130);
    });
  }

  // ─── Prompt Helpers ──────────────────────────────────────────────────────

  /**
   * Ask a question with a default value shown in brackets.
   * Empty input accepts the default. 'b' goes back. 'q' quits.
   */
  async ask(question: string, defaultValue?: string, validate?: (v: string) => string | null): Promise<PromptResult> {
    const defaultHint = defaultValue ? ` [${defaultValue}]: ` : ': ';
    return new Promise<PromptResult>((resolve) => {
      const fullQuestion = `${question}${defaultHint}`;
      this.rl.question(fullQuestion, (raw) => {
        const input = raw.trim();

        // Check for back/quit
        if (input.toLowerCase() === 'b' || input.toLowerCase() === 'back') {
          resolve('__back__');
          return;
        }
        if (input.toLowerCase() === 'q' || input.toLowerCase() === 'quit') {
          resolve('__quit__');
          return;
        }

        // Use default if empty
        const value = input || defaultValue || '';

        // Validate if validator provided
        if (validate) {
          const error = validate(value);
          if (error) {
            console.log(`  ⚠️  ${error}`);
            // Re-ask the same question
            this.ask(question, defaultValue, validate).then(resolve);
            return;
          }
        }

        resolve(value);
      });
    });
  }

  /**
   * Ask user to pick one from a numbered list.
   * Validates selection. Allows 'b' to go back, 'q' to quit.
   */
  async askChoice(question: string, choices: { key: string; label: string }[], defaultKey?: string): Promise<PromptResult> {
    const defaultIdx = defaultKey ? choices.findIndex(c => c.key === defaultKey) : -1;

    // Display choices
    console.log(question);
    for (let i = 0; i < choices.length; i++) {
      const marker = i === defaultIdx ? ' (default)' : '';
      console.log(`  ${i + 1}. ${choices[i].label}${marker}`);
    }

    const defaultHint = defaultIdx >= 0 ? String(defaultIdx + 1) : '';
    const result = await this.ask(`\nChoose`, defaultHint, (v) => {
      const num = parseInt(v, 10);
      if (isNaN(num) || num < 1 || num > choices.length) {
        return `Please enter a number between 1 and ${choices.length}`;
      }
      return null;
    });

    if (result === '__back__' || result === '__quit__') return result;

    const idx = parseInt(result, 10) - 1;
    return choices[idx].key;
  }

  /**
   * Multi-select with checkboxes. Comma-separated numbers.
   * Defaults pre-selected. Allows 'b' to go back, 'q' to quit.
   */
  async askMulti(question: string, choices: { key: string; label: string }[], defaultKeys: string[] = []): Promise<PromptResult> {
    // Display choices
    console.log(question);
    for (let i = 0; i < choices.length; i++) {
      const isChecked = defaultKeys.includes(choices[i].key);
      const marker = isChecked ? '[x]' : '[ ]';
      console.log(`  ${marker} ${i + 1}. ${choices[i].label}`);
    }

    const defaultStr = defaultKeys.map(k => {
      const idx = choices.findIndex(c => c.key === k);
      return idx >= 0 ? String(idx + 1) : k;
    }).join(',');

    const result = await this.ask(`\nSelect (comma-separated numbers)`, defaultStr || '', (v) => {
      const parts = v.split(',').map(p => p.trim()).filter(Boolean);
      for (const part of parts) {
        const num = parseInt(part, 10);
        if (isNaN(num) || num < 1 || num > choices.length) {
          return `Invalid selection: "${part}". Use numbers 1-${choices.length}`;
        }
      }
      return null;
    });

    if (result === '__back__' || result === '__quit__') return result;

    const parts = result.split(',').map(p => p.trim()).filter(Boolean);
    const selected = parts.map(p => {
      const num = parseInt(p, 10);
      return choices[num - 1].key;
    });

    return selected.join(',');
  }

  // ─── Progress Indicator ──────────────────────────────────────────────────

  private showProgress(): void {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Step ${this.currentStep}/${this.totalSteps}`);
    console.log(`${'─'.repeat(50)}\n`);
  }

  // ─── Partial Progress Save ──────────────────────────────────────────────

  private savePartialProgress(): void {
    try {
      writeFileSync(this.partialSavePath, JSON.stringify(this.answers, null, 2));
    } catch (err) {
      this.logger.warn('Failed to save partial progress', { error: String(err) });
    }
  }

  // ─── Validators ──────────────────────────────────────────────────────────

  private validateNonEmpty(value: string): string | null {
    if (!value || value.trim().length === 0) return 'Cannot be empty';
    if (value.length > 50) return 'Must be 50 characters or less';
    return null;
  }

  private validateModelName(value: string): string | null {
    if (!value || value.trim().length === 0) return 'Model name cannot be empty';
    if (!/^[a-zA-Z0-9._:\-]+$/.test(value)) return 'Model name can only contain letters, numbers, dots, colons, and hyphens';
    return null;
  }

  private validatePath(value: string): string | null {
    if (!value || value.trim().length === 0) return 'Path cannot be empty';
    const parent = dirname(value);
    if (!existsSync(parent)) return `Parent directory does not exist: ${parent}`;
    return null;
  }

  // ─── Interactive Onboarding ──────────────────────────────────────────────

  async run(workspaceRoot: string): Promise<OnboardingAnswers | null> {
    const log = this.logger;
    log.info('Starting interactive onboarding');

    const identityDir = resolve(workspaceRoot, 'workspace');

    this.totalSteps = 5;
    this.currentStep = 0;

    console.log('\n🔮 Welcome to Lodestone!\n');
    console.log('Let\'s set up your agent. You can change everything later.');
    console.log('Type "b" to go back, "q" to quit at any step.\n');

    // Step 1: Agent name
    this.currentStep = 1;
    this.showProgress();

    const agentNameResult = await this.ask(
      'What should your agent be called?',
      'Lodestone',
      this.validateNonEmpty
    );
    if (agentNameResult === '__quit__') { this.close(); return null; }
    if (agentNameResult !== '__back__') {
      this.answers.agentName = agentNameResult;
    }

    // Step 2: User name
    this.currentStep = 2;
    this.showProgress();

    const userNameResult = await this.ask(
      'What\'s your name?',
      'User',
      this.validateNonEmpty
    );
    if (userNameResult === '__quit__') { this.close(); return null; }
    if (userNameResult === '__back__') {
      // Go back to step 1
      this.currentStep = 1;
      this.showProgress();
      const retryAgent = await this.ask('What should your agent be called?', this.answers.agentName || 'Lodestone', this.validateNonEmpty);
      if (retryAgent === '__quit__') { this.close(); return null; }
      this.answers.agentName = retryAgent;
      // Re-ask user name
      this.currentStep = 2;
      this.showProgress();
      const retryUser = await this.ask('What\'s your name?', 'User', this.validateNonEmpty);
      if (retryUser === '__quit__') { this.close(); return null; }
      this.answers.userName = retryUser;
    } else {
      this.answers.userName = userNameResult;
    }

    // Step 3: Template selection
    this.currentStep = 3;
    this.showProgress();

    const templateChoices = Object.entries(TEMPLATE_INFO).map(([key, info]) => ({
      key,
      label: `${info.emoji} ${info.name} — ${info.desc}`,
    }));

    const templateResult = await this.askChoice(
      'What kind of work will you do?',
      templateChoices,
      'general'
    );
    if (templateResult === '__quit__') { this.close(); return null; }
    if (templateResult === '__back__') {
      // Go back to user name
      this.currentStep = 2;
      this.showProgress();
      const retryUser = await this.ask('What\'s your name?', this.answers.userName || 'User', this.validateNonEmpty);
      if (retryUser === '__quit__') { this.close(); return null; }
      this.answers.userName = retryUser;
      // Re-ask template
      this.currentStep = 3;
      this.showProgress();
      const retryTemplate = await this.askChoice('What kind of work will you do?', templateChoices, 'general');
      if (retryTemplate === '__quit__') { this.close(); return null; }
      this.answers.templates = [retryTemplate];
    } else {
      this.answers.templates = [templateResult];
    }

    // Step 4: Provider + Model
    this.currentStep = 4;
    this.showProgress();

    const providerChoices = Object.entries(PROVIDER_INFO).map(([key, info]) => ({
      key,
      label: `${info.emoji} ${info.name} — ${info.desc}`,
    }));

    const providerResult = await this.askChoice(
      'Which LLM provider?',
      providerChoices,
      'ollama'
    );
    if (providerResult === '__quit__') { this.close(); return null; }
    if (providerResult === '__back__') {
      // Go back to template
      this.currentStep = 3;
      this.showProgress();
      const retryTemplate = await this.askChoice('What kind of work will you do?', templateChoices, this.answers.templates?.[0] || 'general');
      if (retryTemplate === '__quit__') { this.close(); return null; }
      this.answers.templates = [retryTemplate];
      // Re-ask provider
      this.currentStep = 4;
      this.showProgress();
      const retryProvider = await this.askChoice('Which LLM provider?', providerChoices, 'ollama');
      if (retryProvider === '__quit__') { this.close(); return null; }
      this.answers.provider = retryProvider as 'ollama' | 'openai' | 'anthropic';
    } else {
      this.answers.provider = providerResult as 'ollama' | 'openai' | 'anthropic';
    }

    // Model selection (same step as provider)
    const models = PROVIDER_INFO[this.answers.provider!].models;
    const modelChoices = models.map((m, i) => ({
      key: m,
      label: `${m}${i === 0 ? ' (recommended)' : ''}`,
    }));

    const modelResult = await this.askChoice(
      '\nWhich model?',
      modelChoices,
      models[0]
    );
    if (modelResult === '__quit__') { this.close(); return null; }
    if (modelResult === '__back__') {
      // Go back to provider
      const retryProvider = await this.askChoice('Which LLM provider?', providerChoices, this.answers.provider || 'ollama');
      if (retryProvider === '__quit__') { this.close(); return null; }
      this.answers.provider = retryProvider as 'ollama' | 'openai' | 'anthropic';
      // Re-ask model
      const retryModels = PROVIDER_INFO[this.answers.provider!].models;
      const retryModelChoices = retryModels.map((m: string, i: number) => ({
        key: m,
        label: `${m}${i === 0 ? ' (recommended)' : ''}`,
      }));
      const retryModel = await this.askChoice('\nWhich model?', retryModelChoices, retryModels[0]);
      if (retryModel === '__quit__') { this.close(); return null; }
      this.answers.model = retryModel;
    } else {
      this.answers.model = modelResult;
    }

    // Step 5: Personality
    this.currentStep = 5;
    this.showProgress();

    const personalityChoices = Object.entries(PERSONALITY_INFO).map(([key, info]) => ({
      key,
      label: `${info.emoji} ${info.name} — ${info.desc}`,
    }));

    const personalityResult = await this.askChoice(
      'How should your agent communicate?',
      personalityChoices,
      'balanced'
    );
    if (personalityResult === '__quit__') { this.close(); return null; }
    if (personalityResult === '__back__') {
      // Go back to model
      const retryModel = await this.askChoice('\nWhich model?', modelChoices, this.answers.model || models[0]);
      if (retryModel === '__quit__') { this.close(); return null; }
      this.answers.model = retryModel;
      // Re-ask personality
      const retryPersonality = await this.askChoice('How should your agent communicate?', personalityChoices, 'balanced');
      if (retryPersonality === '__quit__') { this.close(); return null; }
      this.answers.personality = retryPersonality as 'concise' | 'balanced' | 'detailed';
    } else {
      this.answers.personality = personalityResult as 'concise' | 'balanced' | 'detailed';
    }

    // Summary
    console.log('\n' + '═'.repeat(50));
    console.log('  Setup Summary');
    console.log('═'.repeat(50));
    console.log(`  Agent name:   ${this.answers.agentName}`);
    console.log(`  Your name:    ${this.answers.userName}`);
    console.log(`  Template:     ${this.answers.templates?.join(', ')}`);
    console.log(`  Personality:  ${this.answers.personality}`);
    console.log(`  Provider:     ${this.answers.provider}`);
    console.log(`  Model:        ${this.answers.model}`);
    console.log(`  Workspace:    ${identityDir}`);
    console.log('═'.repeat(50));

    const confirmResult = await this.ask('\nCreate workspace? (yes/no)', 'yes');
    if (confirmResult === '__quit__' || confirmResult === '__back__') {
      console.log('Setup cancelled.');
      this.close();
      return null;
    }
    if (confirmResult.toLowerCase() !== 'yes' && confirmResult.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      this.close();
      return null;
    }

    // Build final answers
    const finalAnswers: OnboardingAnswers = {
      agentName: this.answers.agentName || 'Lodestone',
      userName: this.answers.userName || 'User',
      templates: this.answers.templates || ['general'],
      personality: this.answers.personality || 'balanced',
      provider: this.answers.provider || 'ollama',
      model: this.answers.model || 'glm-5.2:cloud',
      workspacePath: identityDir,
    };

    // Create workspace
    createWorkspaceFromAnswers({
      agentName: finalAnswers.agentName,
      userName: finalAnswers.userName,
      template: finalAnswers.templates[0],
      templates: finalAnswers.templates,
      personality: finalAnswers.personality,
      provider: finalAnswers.provider,
      model: finalAnswers.model,
      workspacePath: finalAnswers.workspacePath,
    } as WorkspaceConfig);

    // Clean up partial save
    try {
      const fs = await import('fs/promises');
      await fs.unlink(this.partialSavePath).catch(() => {});
    } catch { }

    console.log(`\n✅ Workspace created at ${finalAnswers.workspacePath}`);
    console.log(`   Identity files written. Config saved to lodestone.config.yaml`);
    console.log(`   Run Lodestone again to start.\n`);

    this.close();
    return finalAnswers;
  }

  // ─── Non-Interactive Mode ────────────────────────────────────────────────

  runNonInteractive(opts: NonInteractiveOptions, workspaceRoot: string): OnboardingAnswers {
    this.logger.info('Running non-interactive onboarding', { opts });

    const answers: OnboardingAnswers = {
      agentName: opts.agentName || process.env.LODESTONE_AGENT_NAME || 'Lodestone',
      userName: opts.userName || process.env.LODESTONE_USER_NAME || 'User',
      templates: opts.template ? [opts.template] : (process.env.LODESTONE_TEMPLATE || 'general').split(',').map(s => s.trim()),
      personality: (opts.personality as 'concise' | 'balanced' | 'detailed') || (process.env.LODESTONE_PERSONALITY as 'concise' | 'balanced' | 'detailed') || 'balanced',
      provider: (opts.provider as 'ollama' | 'openai' | 'anthropic') || (process.env.LODESTONE_PROVIDER as 'ollama' | 'openai' | 'anthropic') || 'ollama',
      model: opts.model || process.env.LODESTONE_MODEL || 'glm-5.2:cloud',
      workspacePath: opts.workspacePath || resolve(workspaceRoot, 'workspace'),
    };

    // Validate template
    if (!TEMPLATE_INFO[answers.templates[0]]) {
      throw new Error(`Invalid template '${answers.templates[0]}'. Valid templates: ${Object.keys(TEMPLATE_INFO).join(', ')}. Check your onboarding configuration.`);
    }

    // Validate provider
    if (!PROVIDER_INFO[answers.provider]) {
      throw new Error(`Invalid provider '${answers.provider}'. Valid providers: ${Object.keys(PROVIDER_INFO).join(', ')}. Check your onboarding configuration.`);
    }

    // Validate model
    if (!PROVIDER_INFO[answers.provider].models.includes(answers.model)) {
      this.logger.warn('Model not in default list, proceeding anyway', { model: answers.model, provider: answers.provider });
    }

    // Create workspace
    createWorkspaceFromAnswers({
      agentName: answers.agentName,
      userName: answers.userName,
      template: answers.templates[0],
      templates: answers.templates,
      personality: answers.personality,
      provider: answers.provider,
      model: answers.model,
      workspacePath: answers.workspacePath,
    } as WorkspaceConfig);

    console.log(`✅ Workspace created at ${answers.workspacePath}`);
    console.log(`   Agent: ${answers.agentName} | Model: ${answers.model} | Provider: ${answers.provider}`);

    this.close();
    return answers;
  }

  // ─── Resume Partial ──────────────────────────────────────────────────────

  async resume(workspaceRoot: string): Promise<OnboardingAnswers | null> {
    try {
      const { readFile, unlink } = await import('fs/promises');
      const raw = await readFile(this.partialSavePath, 'utf-8');
      this.answers = JSON.parse(raw);
      this.logger.info('Resuming from partial save', { answers: this.answers });
      // Clean up
      await unlink(this.partialSavePath).catch(() => {});
    } catch {
      this.logger.warn('No partial save found, starting fresh');
      return this.run(workspaceRoot);
    }

    // If we have enough answers, jump to confirmation
    if (this.answers.agentName && this.answers.userName && this.answers.provider && this.answers.model) {
      const identityDir = resolve(workspaceRoot, 'workspace');
      const finalAnswers: OnboardingAnswers = {
        agentName: this.answers.agentName,
        userName: this.answers.userName,
        templates: this.answers.templates || ['general'],
        personality: this.answers.personality || 'balanced',
        provider: this.answers.provider,
        model: this.answers.model,
        workspacePath: identityDir,
      };

      createWorkspaceFromAnswers({
        agentName: finalAnswers.agentName,
        userName: finalAnswers.userName,
        template: finalAnswers.templates[0],
        templates: finalAnswers.templates,
        personality: finalAnswers.personality,
        provider: finalAnswers.provider,
        model: finalAnswers.model,
        workspacePath: finalAnswers.workspacePath,
      } as WorkspaceConfig);

      console.log(`\n✅ Workspace created at ${finalAnswers.workspacePath}`);
      this.close();
      return finalAnswers;
    }

    // Not enough answers — restart
    this.logger.info('Partial save incomplete, starting fresh');
    return this.run(workspaceRoot);
  }

  // ─── Close ────────────────────────────────────────────────────────────────

  close(): void {
    this.rl.close();
  }
}

// ─── Convenience: Parse CLI args for non-interactive mode ────────────────────

export function parseNonInteractiveArgs(args: string[]): NonInteractiveOptions {
  const opts: NonInteractiveOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--template':
        opts.template = args[++i];
        break;
      case '--provider':
        opts.provider = args[++i];
        break;
      case '--model':
        opts.model = args[++i];
        break;
      case '--agent-name':
        opts.agentName = args[++i];
        break;
      case '--user-name':
        opts.userName = args[++i];
        break;
      case '--personality':
        opts.personality = args[++i];
        break;
      case '--workspace-path':
        opts.workspacePath = args[++i];
        break;
    }
  }

  return opts;
}