/**
 * Lodestone Core — Web Chat Channel
 *
 * Express.js server with Socket.IO for real-time WebSocket chat.
 * Serves a minimal HTML chat UI at `/` (single page, no build step).
 * Zero external deps beyond express and socket.io.
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';

// ─── Web Chat Config ─────────────────────────────────────────────────────

export interface WebChatConfig extends ChannelConfig {
  type: 'webchat';
  /** Port to listen on */
  port: number;
  /** CORS allowed origins (default: '*' for development) */
  corsOrigin?: string;
  /** Path to serve the chat UI from (default: '/') */
  uiPath?: string;
}

// ─── Minimal Chat UI HTML ────────────────────────────────────────────────

const CHAT_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lodestone Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    header { background: #16213e; padding: 12px 20px; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 10px; }
    header h1 { font-size: 16px; font-weight: 600; color: #e94560; }
    #status { font-size: 12px; color: #888; margin-left: auto; }
    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 80%; padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
    .msg.user { align-self: flex-end; background: #0f3460; color: #e0e0e0; border-bottom-right-radius: 4px; }
    .msg.agent { align-self: flex-start; background: #1f4068; color: #e0e0e0; border-bottom-left-radius: 4px; }
    .msg.streaming { opacity: 0.8; }
    .msg .meta { font-size: 11px; color: #888; margin-top: 4px; }
    #input-area { background: #16213e; padding: 12px 20px; border-top: 1px solid #0f3460; display: flex; gap: 10px; }
    #msg-input { flex: 1; padding: 10px 14px; border: 1px solid #0f3460; border-radius: 20px; background: #1a1a2e; color: #e0e0e0; font-size: 14px; outline: none; }
    #msg-input:focus { border-color: #e94560; }
    #send-btn { padding: 10px 20px; border: none; border-radius: 20px; background: #e94560; color: #fff; font-size: 14px; cursor: pointer; }
    #send-btn:hover { background: #c81e45; }
    #send-btn:disabled { background: #555; cursor: not-allowed; }
  </style>
</head>
<body>
  <header>
    <h1>🔮 Lodestone</h1>
    <span id="status">connecting...</span>
  </header>
  <div id="messages"></div>
  <div id="input-area">
    <input id="msg-input" type="text" placeholder="Send a message..." autocomplete="off" />
    <button id="send-btn">Send</button>
  </div>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const messages = document.getElementById('messages');
    const input = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const status = document.getElementById('status');
    let streamingEl = null;

    socket.on('connect', () => { status.textContent = 'connected'; status.style.color = '#4caf50'; });
    socket.on('disconnect', () => { status.textContent = 'disconnected'; status.style.color = '#f44336'; });

    function addMessage(text, type) {
      const div = document.createElement('div');
      div.className = 'msg ' + type;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    function send() {
      const text = input.value.trim();
      if (!text) return;
      addMessage(text, 'user');
      socket.emit('message', text);
      input.value = '';
      sendBtn.disabled = true;
    }

    sendBtn.onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };

    socket.on('response', (text) => {
      if (streamingEl) { streamingEl.textContent = text; streamingEl.classList.remove('streaming'); streamingEl = null; }
      else { addMessage(text, 'agent'); }
      sendBtn.disabled = false;
    });

    socket.on('stream', (text) => {
      if (!streamingEl) { streamingEl = addMessage('', 'agent streaming'); }
      streamingEl.textContent = text;
      messages.scrollTop = messages.scrollHeight;
    });

    socket.on('stream_end', (text) => {
      if (streamingEl) { streamingEl.textContent = text; streamingEl.classList.remove('streaming'); streamingEl = null; }
      sendBtn.disabled = false;
    });

    socket.on('error', (err) => {
      addMessage('Error: ' + err, 'agent');
      sendBtn.disabled = false;
    });
  </script>
</body>
</html>`;

// ─── Web Chat Channel ────────────────────────────────────────────────────

export class WebChatChannel extends Channel {
  private server: any = null; // Express server
  private io: any = null; // Socket.IO server
  private httpServer: any = null; // http.Server
  private sessionMap: Map<string, string> = new Map(); // socketId → sessionId

  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly uiPath: string;

  constructor(config: WebChatConfig) {
    super(config);
    this.port = config.port;
    this.corsOrigin = config.corsOrigin || '*';
    this.uiPath = config.uiPath || '/';
  }

  get id(): string {
    return `webchat:${this.port}`;
  }

  get name(): string {
    return 'Web Chat';
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Dynamic imports — express and socket.io are the only required deps
    let express: any, createServer: any, Server: any;
    try {
      express = (await import('express')).default;
      ({ createServer } = await import('http'));
      ({ Server } = await import('socket.io'));
    } catch (err) {
      console.error('[Channel:WebChat] express or socket.io not installed. Install with: npm install express socket.io');
      throw new Error('express and socket.io packages are required for the WebChat channel. Install with: npm install express socket.io');
    }

    const app = express();

    // Serve chat UI
    app.get(this.uiPath, (_req: any, res: any) => {
      res.type('html').send(CHAT_UI_HTML);
    });

    // Health check endpoint
    app.get('/health', (_req: any, res: any) => {
      res.json({ status: 'ok', channel: this.id, uptime: process.uptime() });
    });

    this.httpServer = createServer(app);

    // Socket.IO
    this.io = new Server(this.httpServer, {
      cors: {
        origin: this.corsOrigin,
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket: any) => {
      console.log(`[Channel:WebChat] Client connected: ${socket.id}`);

      // Generate a session for this connection
      const sessionId = `webchat-${socket.id}`;
      this.sessionMap.set(socket.id, sessionId);

      // Notify the client they're connected
      socket.emit('connected', { sessionId });

      // Handle incoming messages
      socket.on('message', async (text: string) => {
        if (!text || typeof text !== 'string') return;

        const message: ChannelMessage = {
          sessionId,
          content: text,
          senderId: socket.id,
          senderName: `webchat-user-${socket.id.slice(0, 8)}`,
          channelId: this.id,
          timestamp: new Date().toISOString(),
          metadata: {
            socketId: socket.id,
            transport: 'websocket',
          },
        };

        await this.emitMessage(message);
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        console.log(`[Channel:WebChat] Client disconnected: ${socket.id}`);
        this.sessionMap.delete(socket.id);
      });
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.port, () => {
        console.log(`[Channel:WebChat] Server listening on port ${this.port}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });

    this.running = true;
    console.log(`[Channel:WebChat] Started — ${this.id}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Close all connections
    if (this.io) {
      this.io.disconnectSockets(true);
    }

    // Close the HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.close(() => resolve());
      });
    }

    this.sessionMap.clear();
    this.running = false;
    console.log(`[Channel:WebChat] Stopped — ${this.id}`);
  }

  async send(sessionId: string, message: string): Promise<void> {
    if (!this.io) {
      console.error('[Channel:WebChat] Socket.IO not initialized — cannot send');
      return;
    }

    const socketId = this.getSocketId(sessionId);
    if (!socketId) {
      console.error(`[Channel:WebChat] No socket for session ${sessionId}`);
      return;
    }

    this.io.to(socketId).emit('response', message);
  }

  /**
   * Send a streaming partial response.
   */
  streamDelta(sessionId: string, text: string): void {
    if (!this.io) return;

    const socketId = this.getSocketId(sessionId);
    if (!socketId) return;

    this.io.to(socketId).emit('stream', text);
  }

  /**
   * Finalize a streaming response.
   */
  streamEnd(sessionId: string, finalText: string): void {
    if (!this.io) return;

    const socketId = this.getSocketId(sessionId);
    if (!socketId) return;

    this.io.to(socketId).emit('stream_end', finalText);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private getSocketId(sessionId: string): string | null {
    for (const [socketId, sid] of this.sessionMap.entries()) {
      if (sid === sessionId) return socketId;
    }
    // Fallback: extract from sessionId format "webchat-<socketId>"
    if (sessionId.startsWith('webchat-')) {
      return sessionId.replace('webchat-', '');
    }
    return null;
  }
}