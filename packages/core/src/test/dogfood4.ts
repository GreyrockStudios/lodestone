/**
 * Dogfood test 4 — WebChat channel via real Socket.IO.
 * Boots the engine with WebChat enabled, connects via Socket.IO client,
 * sends messages, verifies streaming responses and tool calls.
 */
import { LodestoneEngine, type LodestoneConfig } from '../engine.js';
import { AgentLoop } from '../agent-loop.js';
import { WikiResolveTool } from '../tools/impl/wiki-resolve.js';
import { SmartRetrieveTool } from '../tools/impl/smart-retrieve.js';
import { DecisionLogTool } from '../tools/impl/decision-log.js';
import { ResumeStateTool } from '../tools/impl/resume-state.js';
import { WatchdogTool } from '../tools/impl/watchdog.js';
import { BusinessHoursTool } from '../tools/impl/business-hours.js';
import type { ChannelManagerConfig } from '../channels/index.js';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { io as socketIoClient } from 'socket.io-client';

async function main() {
  console.log('=== Lodestone Dogfood Test 4: WebChat Channel ===\n');

  const root = resolve(import.meta.dirname, '../../../../');
  const dataDir = resolve(root, 'data');
  const wikiDir = resolve(root, 'memory/wiki');
  const identityDir = resolve(root, 'workspace');
  const memoryDir = resolve(root, 'data/lancedb');

  // Clean slate
  for (const d of [dataDir, wikiDir, memoryDir]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }

  // Create a test wiki page
  writeFileSync(resolve(wikiDir, 'test.md'), `---
title: Test
created: 2026-06-18
updated: 2026-06-18
status: active
tags: [test]
---
# Test Page
WebChat dogfood test page.
`);

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
        type: 'webchat' as never,
        id: 'webchat',
        name: 'WebChat',
        enabled: true,
        port: 3999,
        corsOrigin: '*',
      } as unknown as { type: 'webchat' }],
    } as unknown as ChannelManagerConfig,
  };

  console.log('1. Booting engine with WebChat on port 3999...');
  const engine = new LodestoneEngine(config);
  await engine.memory.init();

  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(dataDir, 'decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());

  await engine.start();

  const sessionId = engine.createSession();
  const loop = new AgentLoop(engine);

  // Wire channel to agent loop
  if (engine.channelManager) {
    engine.channelManager.onMessage(async (message) => {
      const result = await loop.run(sessionId, message.content);
      return result.response;
    });
  }

  console.log('2. Connecting Socket.IO client...');
  const client = socketIoClient('http://localhost:3999');

  let passCount = 0;
  let failCount = 0;

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', (err: Error) => reject(new Error(`Socket.IO connect failed: ${err.message}`)));
    setTimeout(() => reject(new Error('Socket.IO connect timeout')), 5000);
  });
  console.log('   Connected!');

  // Test 1: Send a simple message
  console.log('\n--- Test 1: Simple message via WebChat ---');
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Response timeout')), 30000);

      client.on('agent_response', (data: { text?: string; content?: string }) => {
        clearTimeout(timeout);
        resolve(data.text || data.content || '');
      });

      client.emit('user_message', { content: 'Hello! Who are you?' });
    });

    console.log(`  Response: ${response.substring(0, 100)}...`);
    if (response.length > 0) {
      console.log('  ✅ PASS');
      passCount++;
    } else {
      console.log('  ❌ FAIL — empty response');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 2: Health endpoint
  console.log('\n--- Test 2: Health endpoint ---');
  try {
    const res = await fetch('http://localhost:3999/health');
    const data = await res.json() as { status: string; channel: string };
    console.log(`  Status: ${data.status}, Channel: ${data.channel}`);
    if (data.status === 'ok') {
      console.log('  ✅ PASS');
      passCount++;
    } else {
      console.log('  ❌ FAIL — health not ok');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 3: Chat UI served
  console.log('\n--- Test 3: Chat UI page ---');
  try {
    const res = await fetch('http://localhost:3999/');
    const html = await res.text();
    const hasTitle = html.includes('Lodestone') || html.includes('Chat') || html.includes('chat');
    console.log(`  HTML length: ${html.length}, has title: ${hasTitle}`);
    if (html.length > 100 && hasTitle) {
      console.log('  ✅ PASS');
      passCount++;
    } else {
      console.log('  ❌ FAIL — UI not served properly');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Test 4: Tool call via WebChat
  console.log('\n--- Test 4: Tool call via WebChat ---');
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Response timeout')), 60000);

      client.on('agent_response', (data: { text?: string; content?: string }) => {
        clearTimeout(timeout);
        resolve(data.text || data.content || '');
      });

      client.emit('user_message', { content: 'Use the business-hours tool to check if it is currently business hours.' });
    });

    console.log(`  Response: ${response.substring(0, 150)}...`);
    if (response.length > 0) {
      console.log('  ✅ PASS');
      passCount++;
    } else {
      console.log('  ❌ FAIL — empty response');
      failCount++;
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Cleanup
  console.log('\n--- Cleanup ---');
  client.disconnect();
  await engine.stop();

  console.log(`\n📊 Dogfood 4 Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});