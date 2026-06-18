/* eslint-disable @typescript-eslint/no-explicit-any -- TUI code uses dynamic types throughout */
/**
 * Lodestone — TUI Boot & Engine Initialization
 *
 * Handles workspace detection, onboarding flow, engine creation,
 * tool registration, identity loading, and the "surprise me" name picker.
 */

import { LodestoneEngine } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool, WikiSearchTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

export interface BootResult {
  engine: LodestoneEngine;
  loop: AgentLoop;
  sessionId: string;
  identity: any;
  displayName: string;
  workspace: string;
  model: string;
}

/**
 * Boot the Lodestone engine: check workspace, run onboarding if needed,
 * create engine, register tools, load identity, create session.
 */
export async function boot(
  workspace: string,
  defaultModel: string,
  onBootStatus: (msg: string) => void,
): Promise<BootResult> {
  let WORKSPACE = workspace;
  let displayName = 'Lodestone';
  const model = defaultModel;

  // ─── Onboarding check ───────────────────────────────────────────────────

  const workspaceExists = existsSync(resolve(WORKSPACE, 'IDENTITY.md'));
  let onboardingResult: any = null;

  // Note: onboarding is handled by the caller (TUI sets up the flow)
  // This function expects workspace to exist already.

  // ─── Create Engine ──────────────────────────────────────────────────────

  onBootStatus(`Creating engine...`);

  const llmConfig = {
    default: {
      type: 'ollama' as const,
      model: model,
      contextWindow: 32768,
      maxTokens: 4096,
      baseUrl: '' as string | undefined,
    },
  };

  // Check for Ollama base URL
  const effectiveBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api';
  llmConfig.default.baseUrl = effectiveBaseUrl;

  const engine = new LodestoneEngine({
    workspaceRoot: WORKSPACE,
    identityDir: WORKSPACE,
    wikiRoot: resolve(WORKSPACE, 'memory/wiki'),
    memoryDir: resolve(WORKSPACE, 'data/lancedb'),
    llm: llmConfig,
  });

  // ─── Initialize Memory ──────────────────────────────────────────────────

  onBootStatus(`Initializing memory...`);
  await engine.memory.init();

  // ─── Initialize Self-Improvement ────────────────────────────────────────

  onBootStatus(`Initializing self-improvement...`);
  await engine.improvement.init();

  // ─── Register Tools ────────────────────────────────────────────────────

  onBootStatus(`Registering tools...`);
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

  // ─── Load Identity ──────────────────────────────────────────────────────

  onBootStatus(`Loading identity...`);
  const identity = await engine.identity.load();
  displayName = identity?.identity?.name || displayName;

  // ─── Create Session ─────────────────────────────────────────────────────

  onBootStatus(`Creating session...`);
  const sessionId = engine.createSession();
  const loop = new AgentLoop(engine, {
    maxToolRounds: 10,
    maxTokens: 4096,
    temperature: 0.7,
    stream: true,
    autoCapture: true,
    autoRecall: true,
  });

  return { engine, loop, sessionId, identity, displayName, workspace: WORKSPACE, model };
}

/**
 * Handle the "surprise me" name generation — asks the LLM to pick a name.
 * Returns the chosen name or null if it fails.
 */
export async function generateSurpriseName(
  engine: LodestoneEngine,
  userName: string,
  templates: string[],
  onStatus: (msg: string) => void,
): Promise<string | null> {
  try {
    onStatus('Asking the model to pick a name...');
    const { generateText } = await import('ai');
    const model = engine.llm.getDefault().getModel();
    const nameResult = await generateText({
      model,
      prompt: `You are an AI agent being set up for the first time. Your user's name is "${userName}". Your focus areas are: ${templates?.join(', ') || 'general'}. Your personality style is: balanced. Pick a single name for yourself — it should be unique, memorable, 4-8 characters, and easy to type. It should feel personal but not cute. Respond with ONLY the name, nothing else. No punctuation, no explanation.`,
      maxOutputTokens: 20,
      temperature: 0.9,
    });
    const chosenName = nameResult.text.trim().replace(/["'`.*\/@#$%^&()\[\]{}|;:!?]/g, '').split(/\s/)[0];
    if (chosenName && chosenName.length >= 2 && chosenName.length <= 20) {
      return chosenName;
    }
    return null;
  } catch (e) {
    console.error('Name generation failed:', e);
    return null;
  }
}

/**
 * Apply a chosen name to identity files (IDENTITY.md, SOUL.md) and
 * rename the agent workspace directory.
 */
export function applyAgentName(workspace: string, chosenName: string): void {
  // Update IDENTITY.md
  const identityPath = resolve(workspace, 'IDENTITY.md');
  if (existsSync(identityPath)) {
    let idContent = readFileSync(identityPath, 'utf-8');
    idContent = idContent.replace(/\-\s\*\*Name:\*\*\s*.+/g, `- **Name:** ${chosenName}`);
    idContent = idContent.replace(/\{\{name\}\}/g, chosenName);
    writeFileSync(identityPath, idContent);
  }

  // Update SOUL.md
  const soulPath = resolve(workspace, 'SOUL.md');
  if (existsSync(soulPath)) {
    let soulContent = readFileSync(soulPath, 'utf-8');
    soulContent = soulContent.replace(/\{\{name\}\}/g, chosenName);
    writeFileSync(soulPath, soulContent);
  }

  // Rename agent workspace directory
  const oldAgentDir = resolve(workspace, 'memory/agents/lodestone');
  const newAgentDir = resolve(workspace, `memory/agents/${chosenName.toLowerCase().replace(/\s+/g, '-')}`);
  if (existsSync(oldAgentDir) && !existsSync(newAgentDir)) {
    try {
      const { renameSync } = require('fs');
      renameSync(oldAgentDir, newAgentDir);
    } catch {}
  }
}