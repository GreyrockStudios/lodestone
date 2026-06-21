/**
 * Lodestone Tool — LSP Bridge
 *
 * Language server bridge for code intelligence.
 * Provides completion, definition, hover, references, symbols, and diagnostics
 * via the Language Server Protocol (LSP) over stdio (JSON-RPC).
 *
 * Supported language servers:
 * - TypeScript: typescript-language-server
 * - Python: pyright
 * - Go: gopls
 * - Rust: rust-analyzer
 *
 * Language servers are spawned via child_process and communicated with using
 * LSP JSON-RPC over stdio. Running servers are cached in a static Map.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { getLogger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Language = 'typescript' | 'python' | 'go' | 'rust';

interface LspServer {
  process: ChildProcess;
  language: Language;
  workspaceRoot: string;
  initialized: boolean;
  /** Monotonic request ID counter */
  nextId: number;
  /** Pending requests awaiting responses */
  pending: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  /** Buffer for incomplete messages */
  buffer: string;
  /** Diagnostics cache */
  diagnostics: Map<string, unknown[]>;
}

interface LspResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

// ─── Server Configuration ─────────────────────────────────────────────────────

const SERVER_CONFIG: Record<Language, { command: string; args?: string[]; installHint: string }> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    installHint: 'pip install pyright',
  },
  go: {
    command: 'gopls',
    args: ['-mode=stdio'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  rust: {
    command: 'rust-analyzer',
    installHint: 'rustup component add rust-analyzer',
  },
};

// ─── Tool ───────────────────────────────────────────────────────────────────

export class LspTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'lsp',
    name: 'LSP Bridge',
    description:
      'Language server bridge for code intelligence. ' +
      'Actions: initialize, completion, definition, hover, references, symbols, diagnostics, shutdown. ' +
      'Supports TypeScript, Python, Go, and Rust.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'LSP action: initialize, completion, definition, hover, references, symbols, diagnostics, or shutdown',
        required: true,
        enum: ['initialize', 'completion', 'definition', 'hover', 'references', 'symbols', 'diagnostics', 'shutdown'],
      },
      {
        name: 'filePath',
        type: 'string',
        description: 'File path (absolute or relative to workspace). Required for all actions except initialize/shutdown.',
        required: false,
      },
      {
        name: 'line',
        type: 'number',
        description: 'Line number (0-based). Required for completion, definition, hover, references.',
        required: false,
      },
      {
        name: 'character',
        type: 'number',
        description: 'Character offset (0-based). Required for completion, definition, hover, references.',
        required: false,
      },
      {
        name: 'language',
        type: 'string',
        description: 'Language for initialize: typescript, python, go, or rust',
        required: false,
        enum: ['typescript', 'python', 'go', 'rust'],
      },
      {
        name: 'workspaceRoot',
        type: 'string',
        description: 'Workspace root path (overrides context.workspaceRoot)',
        required: false,
      },
    ],
    sideEffects: false, // read ops by default; initialize/shutdown handled dynamically
    requiresApproval: false,
    timeout: 30000,
  };

  // ─── Static server registry (shared across instances) ──────────────────────

  private static servers: Map<string, LspServer> = new Map();
  private logger = getLogger('LspTool');

  private static serverKey(language: Language, workspaceRoot: string): string {
    return `${language}:${workspaceRoot}`;
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const action = params.action as string;
    const workspaceRoot = (params.workspaceRoot as string) || context.workspaceRoot;
    const language = params.language as Language | undefined;

    try {
      switch (action) {
        case 'initialize':
          return await this.handleInitialize(language!, workspaceRoot, start);

        case 'shutdown':
          return await this.handleShutdown(language, workspaceRoot, start);

        case 'completion':
        case 'definition':
        case 'hover':
        case 'references':
        case 'symbols':
        case 'diagnostics':
          return await this.handleRequest(action, params, workspaceRoot, start);

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: initialize, completion, definition, hover, references, symbols, diagnostics, shutdown',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `LSP operation failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Initialize ─────────────────────────────────────────────────────────────

  private async handleInitialize(
    language: Language,
    workspaceRoot: string,
    start: number,
  ): Promise<ToolResult> {
    if (!language) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: language',
        error: 'language is required for initialize action',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const config = SERVER_CONFIG[language];
    if (!config) {
      return {
        success: false,
        data: null,
        summary: `Unsupported language: ${language}`,
        error: `Supported: ${Object.keys(SERVER_CONFIG).join(', ')}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const key = LspTool.serverKey(language, workspaceRoot);
    const existing = LspTool.servers.get(key);
    if (existing?.initialized) {
      return {
        success: true,
        data: { language, workspaceRoot, reused: true },
        summary: `Language server for ${language} already running at ${workspaceRoot}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Check if the binary exists
    try {
      await this.checkBinary(config.command);
    } catch (err) {
      this.logger.warn('LSP server binary not found', { language, command: config.command, error: err instanceof Error ? err.message : String(err) });
      return {
        success: false,
        data: null,
        summary: `Language server binary not found: ${config.command}`,
        error: `Binary '${config.command}' not found. Install with: ${config.installHint}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Spawn the language server
    const proc = spawn(config.command, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspaceRoot,
    });

    const server: LspServer = {
      process: proc,
      language,
      workspaceRoot,
      initialized: false,
      nextId: 1,
      pending: new Map(),
      buffer: '',
      diagnostics: new Map(),
    };

    // Set up message handling
    proc.stdout?.on('data', (chunk: Buffer) => this.handleStdout(server, chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Log stderr but don't fail — language servers can be noisy
      void chunk;
    });
    proc.on('exit', (code) => {
      // Reject all pending requests
      for (const [, { reject }] of server.pending) {
        reject(new Error(`Language server exited with code ${code}`));
      }
      server.pending.clear();
      LspTool.servers.delete(key);
    });

    LspTool.servers.set(key, server);

    // Send initialize request
    const initResult = await this.sendRequest(server, 'initialize', {
      processId: process.pid,
      clientInfo: { name: 'lodestone', version: '0.1' },
      rootUri: `file://${workspaceRoot}`,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: {},
          publishDiagnostics: {},
        },
        workspace: {
          symbol: {},
        },
      },
    });

    // Send initialized notification
    this.sendNotification(server, 'initialized', {});

    server.initialized = true;

    return {
      success: true,
      data: {
        language,
        workspaceRoot,
        capabilities: (initResult as { capabilities?: unknown })?.capabilities || {},
      },
      summary: `Initialized ${language} language server for ${workspaceRoot}`,
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────────

  private async handleShutdown(
    language: Language | undefined,
    workspaceRoot: string,
    start: number,
  ): Promise<ToolResult> {
    if (language) {
      const key = LspTool.serverKey(language, workspaceRoot);
      const server = LspTool.servers.get(key);
      if (!server) {
        return {
          success: false,
          data: null,
          summary: `No ${language} server running for ${workspaceRoot}`,
          error: 'NotRunning',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      await this.shutdownServer(server);
      LspTool.servers.delete(key);
      return {
        success: true,
        data: { language, workspaceRoot },
        summary: `Shut down ${language} language server`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // No language specified — shut down all servers for this workspace
    const keys: string[] = [];
    for (const [key, server] of LspTool.servers) {
      if (server.workspaceRoot === workspaceRoot) {
        await this.shutdownServer(server);
        keys.push(key);
      }
    }
    for (const key of keys) LspTool.servers.delete(key);

    return {
      success: true,
      data: { workspaceRoot, stopped: keys.length },
      summary: `Shut down ${keys.length} language server(s) for ${workspaceRoot}`,
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }

  // ─── Request Handler ────────────────────────────────────────────────────────

  private async handleRequest(
    action: string,
    params: Record<string, unknown>,
    workspaceRoot: string,
    start: number,
  ): Promise<ToolResult> {
    const filePath = params.filePath as string | undefined;
    const line = params.line as number | undefined;
    const character = params.character as number | undefined;

    if (!filePath) {
      return {
        success: false,
        data: null,
        summary: `Missing required parameter: filePath`,
        error: 'filePath is required for this action',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Resolve file path
    const absPath = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath);
    if (!existsSync(absPath)) {
      return {
        success: false,
        data: null,
        summary: `File not found: ${absPath}`,
        error: 'NotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Find a running server for this workspace
    const server = this.findServer(workspaceRoot);
    if (!server) {
      return {
        success: false,
        data: null,
        summary: 'No language server running. Call initialize first.',
        error: 'NoServer',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const fileUri = `file://${absPath}`;

    // Send textDocument/didOpen to ensure the server knows about this file
    this.sendNotification(server, 'textDocument/didOpen', {
      textDocument: {
        uri: fileUri,
        languageId: server.language,
        version: 1,
        text: '', // We let the server read from disk
      },
    });

    try {
      let result: unknown;

      switch (action) {
        case 'completion':
          if (line === undefined || character === undefined) {
            return this.missingPosition(start);
          }
          result = await this.sendRequest(server, 'textDocument/completion', {
            textDocument: { uri: fileUri },
            position: { line, character },
          });
          break;

        case 'definition':
          if (line === undefined || character === undefined) {
            return this.missingPosition(start);
          }
          result = await this.sendRequest(server, 'textDocument/definition', {
            textDocument: { uri: fileUri },
            position: { line, character },
          });
          break;

        case 'hover':
          if (line === undefined || character === undefined) {
            return this.missingPosition(start);
          }
          result = await this.sendRequest(server, 'textDocument/hover', {
            textDocument: { uri: fileUri },
            position: { line, character },
          });
          break;

        case 'references':
          if (line === undefined || character === undefined) {
            return this.missingPosition(start);
          }
          result = await this.sendRequest(server, 'textDocument/references', {
            textDocument: { uri: fileUri },
            position: { line, character },
            context: { includeDeclaration: true },
          });
          break;

        case 'symbols':
          result = await this.sendRequest(server, 'textDocument/documentSymbol', {
            textDocument: { uri: fileUri },
          });
          break;

        case 'diagnostics':
          // Diagnostics are pushed asynchronously via publishDiagnostics notification
          // Return whatever we've cached
          result = server.diagnostics.get(fileUri) || [];
          break;

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Unreachable',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }

      return {
        success: true,
        data: { action, filePath: absPath, result },
        summary: `LSP ${action} for ${absPath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `LSP ${action} failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── LSP Protocol ─────────────────────────────────────────────────────────

  private sendRequest(server: LspServer, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = server.nextId++;
      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      server.pending.set(id, { resolve, reject });
      this.writeMessage(server, message);

      // Timeout: reject after 25s
      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out after 25s`));
        }
      }, 25000);
    });
  }

  private sendNotification(server: LspServer, method: string, params: unknown): void {
    const message = { jsonrpc: '2.0', method, params };
    this.writeMessage(server, message);
  }

  private writeMessage(server: LspServer, message: unknown): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    server.process.stdin?.write(header + content);
  }

  private handleStdout(server: LspServer, chunk: Buffer): void {
    server.buffer += chunk.toString();

    // Parse complete messages (Content-Length framing)
    while (true) {
      const headerEnd = server.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = server.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        server.buffer = server.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const contentStart = headerEnd + 4;
      const contentEnd = contentStart + contentLength;

      if (server.buffer.length < contentEnd) break; // Incomplete message

      const content = server.buffer.slice(contentStart, contentEnd);
      server.buffer = server.buffer.slice(contentEnd);

      try {
        const msg = JSON.parse(content) as LspResponse;

        // Response to a request
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const pending = server.pending.get(msg.id);
          if (pending) {
            server.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        }

        // Notification (e.g., publishDiagnostics)
        if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
          const p = msg.params as { uri: string; diagnostics: unknown[] };
          server.diagnostics.set(p.uri, p.diagnostics);
        }
      } catch (err) {
        this.logger.warn('Malformed LSP JSON message, skipping', { error: err instanceof Error ? err.message : String(err) });
        // Malformed JSON — skip
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async checkBinary(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('which', [command], { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} not found`));
      });
      proc.on('error', () => reject(new Error(`${command} not found`)));
    });
  }

  private findServer(workspaceRoot: string): LspServer | undefined {
    for (const server of LspTool.servers.values()) {
      if (server.workspaceRoot === workspaceRoot && server.initialized) {
        return server;
      }
    }
    return undefined;
  }

  private async shutdownServer(server: LspServer): Promise<void> {
    try {
      await this.sendRequest(server, 'shutdown', {});
      this.sendNotification(server, 'exit', {});
    } catch (err) {
      this.logger.warn('LSP server shutdown failed', { language: server.language, workspaceRoot: server.workspaceRoot, error: err instanceof Error ? err.message : String(err) });
      // Best-effort shutdown
    }
    server.process.kill();
  }

  private missingPosition(start: number): ToolResult {
    return {
      success: false,
      data: null,
      summary: 'Missing required parameters: line and character',
      error: 'line and character are required for this action (0-based)',
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }
}