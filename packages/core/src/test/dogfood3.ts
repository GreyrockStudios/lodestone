/**
 * Dogfood test 3 — WebChat channel end-to-end via Socket.IO.
 * Boots Lodestone with WebChat, connects as a client, sends message, gets response.
 */
import { LodestoneEngine, type LodestoneConfig } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { StreamHandler } from '../streaming/handler.js';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

async function main() {
  console.log('=== Lodestone Dogfood 3: WebChat E2E ===\n');

  const root = resolve(import.meta.dirname, '../../../../');
  const dataDir = resolve(root, 'data');
  const wikiDir = resolve(root, 'memory/wiki');
  const identityDir = resolve(root, 'workspace');
  const memoryDir = resolve(root, 'data/lancedb');
  for (const d of [dataDir, wikiDir, identityDir, memoryDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  const config: LodestoneConfig = {
    workspaceRoot: root,
    identityDir,
    wikiRoot: wikiDir,
    memoryDir,
    maxConcurrentTools: 4,
    maxConcurrentJobs: 2,
    compactionThreshold: 0.5,
    llm: {
      default: {
        type: 'ollama',
        model: 'glm-5.2:cloud',
        baseUrl: 'http://127.0.0.1:11434/api',
        contextWindow: 128000,
        maxTokens: 2048,
      },
    },
    channels: {
      channels: [
        {
          id: 'webchat',
          type: 'webchat' as const,
          name: 'WebChat',
          enabled: true,
          port: 3998,
          corsOrigin: '*',
          streaming: true,
        } as never,
      ],
    },
  };

  console.log('1. Booting engine with WebChat on port 3998...');
  const engine = new LodestoneEngine(config);
  await engine.memory.init();

  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(dataDir, 'decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  await engine.start();

  const loop = new AgentLoop(engine);

  // Wire channels
  engine.channelManager!.onMessage(async (message) => {
    try {
      let sessionId: string;
      const existing = engine.sessions.list().find(s =>
        s.metadata.channelSessionId === message.sessionId
      );
      if (existing) {
        sessionId = existing.id;
      } else {
        sessionId = engine.createSession();
        const session = engine.sessions.get(sessionId);
        if (session) {
          session.metadata.channelSessionId = message.sessionId;
          session.metadata.channelId = message.channelId;
        }
      }

      const stream = new StreamHandler();
      let streamBuffer = '';
      stream.on('text_delta', (event) => {
        const data = event.data as { text?: string };
        if (data.text) {
          streamBuffer += data.text;
          engine.channelManager!.streamDelta(message.sessionId, data.text);
        }
      });

      const result = await loop.run(sessionId, message.content, stream);
      return result.response;
    } catch (err) {
      console.error('[Lodestone] Channel error:', err);
      return 'Sorry, an error occurred.';
    }
  });

  console.log('2. Channels active:', engine.channelManager!.listChannels().length);
  console.log('3. Testing HTTP endpoints...');

  // Test health endpoint
  let passCount = 0;
  let failCount = 0;

  try {
    const res = await fetch('http://localhost:3998/health');
    const data = await res.json() as { status?: string };
    assert(res.status === 200, `health status ${res.status}`);
    assert(data.status === 'ok', `health body ${JSON.stringify(data)}`);
    console.log('  ✅ Health endpoint works');
    passCount++;
  } catch (err) {
    console.log(`  ❌ Health endpoint failed: ${err}`);
    failCount++;
  }

  // Test UI endpoint
  try {
    const res = await fetch('http://localhost:3998/');
    const html = await res.text();
    assert(res.status === 200, `UI status ${res.status}`);
    assert(html.includes('<!DOCTYPE html>'), 'no HTML doctype');
    console.log(`  ✅ Chat UI served (${html.length} chars)`);
    passCount++;
  } catch (err) {
    console.log(`  ❌ UI endpoint failed: ${err}`);
    failCount++;
  }

  // Test channel health
  try {
    const health = engine.channelManager!.getHealth();
    const keys = Object.keys(health);
    assert(keys.length === 1, `expected 1 channel, got ${keys.length}`);
    assert(health[keys[0]].status === 'healthy', `expected healthy, got ${health[keys[0]].status}`);
    console.log(`  ✅ Channel health: ${keys[0]} = ${health[keys[0]].status}`);
    passCount++;
  } catch (err) {
    console.log(`  ❌ Channel health failed: ${err}`);
    failCount++;
  }

  // Test Socket.IO connection
  console.log('4. Testing Socket.IO connection...');
  const { io } = await import('socket.io-client');

  const socket = io('http://localhost:3998', { transports: ['websocket'] });

  const connected = await new Promise<boolean>((resolve) => {
    socket.on('connected', () => resolve(true));
    socket.on('connect_error', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });

  if (connected) {
    console.log('  ✅ Socket.IO connected');
    passCount++;
  } else {
    console.log('  ❌ Socket.IO connection failed');
    failCount++;
  }

  // Test sending a message and getting a response
  if (connected) {
    console.log('5. Sending message via Socket.IO...');

    const response = await new Promise<string | null>((resolve) => {
      socket.on('response', (data: unknown) => {
        const text = typeof data === 'string' ? data : (data as { text?: string })?.text || '';
        resolve(text);
      });

      socket.emit('message', { content: 'Hi! Who are you and what can you do?' });

      setTimeout(() => resolve(null), 60000);
    });

    if (response && response.length > 0) {
      console.log(`  ✅ Got response (${response.length} chars): ${response.substring(0, 150)}...`);
      passCount++;
    } else {
      console.log('  ❌ No response received within timeout');
      failCount++;
    }

    socket.disconnect();
  }

  await engine.stop();
  console.log(`\n📊 WebChat E2E Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});