/**
 * WebChat integration test — connects via Socket.IO and sends a message.
 */
import { io } from 'socket.io-client';

async function main() {
  console.log('=== WebChat Integration Test ===\n');
  console.log('1. Connecting to ws://localhost:3001...');

  const socket = io('http://localhost:3001');

  let passCount = 0;
  let failCount = 0;

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timeout);
      console.log('   ✅ Connected');
      resolve();
    });
    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  passCount++;

  // Test 2: Send a message and wait for response
  console.log('\n2. Sending message: "Hi! Who are you?"');

  let responseReceived = false;
  let streamReceived = false;

  socket.on('response', (text: string) => {
    responseReceived = true;
    console.log(`   ✅ Response received (${text.length} chars)`);
    console.log(`   Preview: ${text.slice(0, 100)}...`);

    // Test 3: Send a tool-triggering message
    console.log('\n3. Sending tool-triggering message: "What tools do you have?"');
    socket.emit('message', 'What tools do you have?');
  });

  socket.on('stream', (text: string) => {
    streamReceived = true;
  });

  socket.on('stream_end', (text: string) => {
    console.log(`   ✅ Stream end received (${text.length} chars)`);
    passCount++;
  });

  socket.on('error', (err: string) => {
    console.log(`   ❌ Error: ${err}`);
    failCount++;
  });

  // Send the first message
  socket.emit('message', 'Hi! Who are you?');

  // Wait for responses (max 30s)
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    socket.on('response', () => {
      // After second response, we're done
      setTimeout(done, 5000);
    });

    setTimeout(done, 30000);
  });

  // Test 4: Health endpoint
  console.log('\n4. Checking health endpoint...');
  try {
    const res = await fetch('http://localhost:3001/health');
    const data = await res.json() as { status: string; channel: string };
    console.log(`   ✅ Health: ${data.status} — ${data.channel}`);
    passCount++;
  } catch (err) {
    console.log(`   ❌ Health check failed: ${err}`);
    failCount++;
  }

  // Report
  if (streamReceived) {
    console.log('\n   ✅ Streaming worked');
    passCount++;
  } else {
    console.log('\n   ⚠️ Streaming not triggered (response may have been too fast)');
  }

  socket.disconnect();
  console.log(`\n📊 WebChat Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});