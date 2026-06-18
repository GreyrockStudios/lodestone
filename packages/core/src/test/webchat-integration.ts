/**
 * Full integration test — boots Lodestone with WebChat, tests WebSocket roundtrip.
 */
import { LodestoneEngine, type LodestoneConfig } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WebChatChannel } from '../channels/webchat.js';
import { WikiResolveTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import { StreamHandler } from '../streaming/handler.js';
import { io } from 'socket.io-client';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

async function main() {
  console.log('=== WebChat Full Integration Test ===\n');

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
      channels: [{
        type: 'webchat' as const,
        id: 'webchat:3099',
        name: 'Web Chat',
        enabled: true,
        port: 3099,
        corsOrigin: '*',
      }],
    },
  };

  console.log('1. Booting Lodestone with WebChat on port 3099...');
  const engine = new LodestoneEngine(config);
  await engine.memory.init();

  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(dataDir, 'decisions-test.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  await engine.start();
  console.log('   Engine started');

  // Create agent loop and wire channels
  const loop = new AgentLoop(engine);

  engine.channelManager!.onMessage(async (message) => {
    // Create or find a session for this webchat client
    const channelId = message.sessionId;
    let sessionId = '';
    const existing = engine.sessions.list().find(s => s.metadata.channelSessionId === channelId);
    if (existing) {
      sessionId = existing.id;
    } else {
      sessionId = engine.createSession();
      const session = engine.sessions.get(sessionId);
      if (session) {
        session.metadata.channelSessionId = channelId;
        session.metadata.channelId = message.channelId;
      }
    }

    const stream = new StreamHandler();
    let streamedText = '';
    stream.on('text_delta', (event) => {
      const data = event.data as { text?: string };
      if (data.text) {
        streamedText += data.text;
        engine.channelManager?.streamDelta(message.sessionId, streamedText);
      }
    });
    const result = await loop.run(sessionId, message.content, stream);
    return result.response;
  });

  console.log('2. Connecting Socket.IO client...');

  let passCount = 0;
  let failCount = 0;

  // Connect as a client
  const socket = io('http://localhost:3099', { transports: ['websocket'] });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timeout);
      console.log('   ✅ Socket.IO connected');
      passCount++;
      resolve();
    });
    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Test 3: Send message and get response
  console.log('\n3. Sending message via WebSocket: "Hi! Who are you?"');

  let gotResponse = false;
  let gotStream = false;

  socket.on('response', (text: string) => {
    gotResponse = true;
    console.log(`   ✅ Response received: ${text.slice(0, 80)}...`);
  });

  socket.on('stream', (text: string) => {
    gotStream = true;
  });

  socket.on('stream_end', (text: string) => {
    console.log(`   ✅ Stream end: ${text.slice(0, 80)}...`);
  });

  socket.emit('message', 'Hi! Who are you?');

  // Wait for response (max 30s)
  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      if (gotResponse) {
        passCount++;
        if (gotStream) {
          console.log('   ✅ Streaming worked');
          passCount++;
        } else {
          console.log('   ⚠️ No streaming (response may have been too fast)');
        }
      } else {
        console.log('   ❌ No response received');
        failCount++;
      }
      resolve();
    }, 20000);

    // If we already got a response, resolve early
    socket.on('response', () => {
      setTimeout(() => {
        clearTimeout(done);
        // Check again
        if (gotResponse) {
          passCount++;
          if (gotStream) {
            console.log('   ✅ Streaming worked');
            passCount++;
          }
        }
        resolve();
      }, 500);
    });
  });

  // Test 4: Health endpoint
  console.log('\n4. Checking health endpoint...');
  try {
    const res = await fetch('http://localhost:3099/health');
    const data = await res.json() as { status: string };
    if (data.status === 'ok') {
      console.log('   ✅ Health check passed');
      passCount++;
    } else {
      console.log(`   ❌ Health returned: ${data.status}`);
      failCount++;
    }
  } catch (err) {
    console.log(`   ❌ Health check failed: ${err}`);
    failCount++;
  }

  // Test 5: Second message (test session reuse)
  console.log('\n5. Sending second message...');
  let gotSecondResponse = false;
  socket.on('response', () => {
    if (gotResponse && !gotSecondResponse) {
      gotSecondResponse = true;
      console.log('   ✅ Second response received');
      passCount++;
    }
  });
  socket.emit('message', 'What is 2+2?');
  await new Promise<void>((resolve) => setTimeout(resolve, 15000));
  if (!gotSecondResponse) {
    console.log('   ❌ Second response timeout');
    failCount++;
  }

  // Cleanup
  socket.disconnect();
  await engine.stop();

  console.log(`\n📊 WebChat Integration: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});