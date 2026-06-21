/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Shared Boot Logic
 *
 * Extracts the engine startup sequence (register tools, create session,
 * wire channels, create agent loop, start engine) so both main.ts and
 * cli/start.ts use the same code path.
 */

import { LodestoneEngine, type LodestoneConfig } from './engine.js';
import { AgentLoop } from './agent-loop.js';
import { registerBuiltinTools } from './tools/register-builtin.js';

export interface BootResult {
  engine: LodestoneEngine;
  loop: AgentLoop;
  sessionId: string;
}

/**
 * Boot a full Lodestone engine from a config object.
 *
 * Performs:
 * 1. Create engine + init memory
 * 2. Register all 39 built-in tools
 * 3. Register proactive jobs (sensorium, sleep-cycle, drift-detection)
 * 4. Start engine
 * 5. Create session
 * 6. Create agent loop + wire into engine
 * 7. Wire channels to agent loop (with streaming support)
 *
 * Does NOT handle: config loading (use loadConfigFromFile), onboarding,
 * process signal handlers, or keeping the process alive.
 */
export async function bootEngine(config: LodestoneConfig): Promise<BootResult> {
  // 1. Create engine + init memory
  const engine = new LodestoneEngine(config);
  await engine.memory.init();

  // 2. Register all 39 built-in tools
  registerBuiltinTools(engine, config.workspaceRoot);

  // 3. Register proactive jobs
  engine.registerJob({
    id: 'sensorium',
    name: 'Lodestone Sensorium',
    schedule: { kind: 'interval', everyMs: 30 * 60 * 1000 },
    description: 'Health check — verify all systems operational',
  });
  engine.registerJob({
    id: 'sleep-cycle',
    name: 'Lodestone Sleep Cycle',
    schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'America/Toronto' },
    description: 'Nightly consolidation: harvest, mine, reflect, consolidate',
  });
  engine.registerJob({
    id: 'drift-detection',
    name: 'Lodestone Drift Detection',
    schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' },
    description: 'Weekly check: behavior vs core principles',
  });

  // 4. Start engine
  await engine.start();

  // 5. Create session
  const sessionId = engine.createSession();

  // 6. Create agent loop + wire into engine — respect config autoCapture setting
  const autoCapture = config.autoCapture ?? true;
  const loop = new AgentLoop(engine, { autoCapture });
  engine.setAgentLoop(loop);

  // 7. Wire channels to agent loop (with streaming support)
  if (engine.channelManager) {
    engine.channelManager.onMessage(async (message) => {
      try {
        // Find or create a session for this channel+user
        let session_id: string;
        const existingSession = engine.sessions.list().find(s =>
          s.metadata.channelSessionId === message.sessionId
        );
        if (existingSession) {
          session_id = existingSession.id;
        } else {
          session_id = engine.createSession();
          engine.sessions.updateState(session_id, {
            currentTask: `Chat via ${message.channelId}`,
            progress: 'active',
          });
          // Track which channel session this belongs to
          const session = engine.sessions.get(session_id);
          if (session) {
            session.metadata.channelSessionId = message.sessionId;
            session.metadata.channelId = message.channelId;
          }
        }

        // Create a stream handler that bridges to the channel's streaming methods
        const { StreamHandler } = await import('./streaming/handler.js');
        const stream = new StreamHandler();
        let streamedText = '';
        stream.on('text_delta', (event: { data: unknown }) => {
          const data = event.data as { text?: string };
          if (data.text) {
            streamedText += data.text;
            engine.channelManager?.streamDelta(message.sessionId, streamedText);
          }
        });

        // Run the agent loop with streaming
        const result = await loop.run(session_id, message.content, stream);
        return result.response;
      } catch (err) {
        console.error('[Lodestone] Channel message error:', err);
        return 'Sorry, an error occurred processing your message.';
      }
    });
  }

  return { engine, loop, sessionId };
}