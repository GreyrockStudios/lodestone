/**
 * Lodestone Tool — File Operations
 *
 * Read, write, list, and search files within the workspace.
 * Sandboxed to the workspace root — cannot escape.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface FileOpsConfig {
  /** Workspace root — file ops are sandboxed to this directory */
  workspaceRoot: string;
  /** Allow write operations (default: true) */
  allowWrite?: boolean;
  /** Max file size to read (default: 1MB) */
  maxReadSize?: number;
}

export class FileOpsTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'file-ops',
    name: 'File Operations',
    description: 'Read, write, list, and search files within the workspace. Operations: read, write, list, search.',
    parameters: [
      { name: 'operation', type: 'string', description: 'Operation: read, write, list, or search', required: true },
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'content', type: 'string', description: 'Content to write (for write operation)', required: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 10000,
  };

  private config: Required<FileOpsConfig>;

  constructor(config: FileOpsConfig) {
    this.config = {
      workspaceRoot: config.workspaceRoot,
      allowWrite: config.allowWrite ?? true,
      maxReadSize: config.maxReadSize || 1024 * 1024,
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const operation = params.operation as string;
    const path = params.path as string;
    const start = Date.now();

    // Sandbox: resolve path within workspace
    const safePath = this.sandboxPath(path);
    if (!safePath) {
      return {
        success: false, data: null,
        summary: `Path escapes workspace: ${path}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    try {
      switch (operation) {
        case 'read': return await this.read(safePath, start);
        case 'write': return await this.write(safePath, params.content as string, start);
        case 'list': return await this.list(safePath, start);
        case 'search': return await this.search(safePath, params.content as string || '', start);
        default:
          return {
            success: false, data: null,
            summary: `Unknown operation: ${operation}`,
            error: `Valid operations: read, write, list, search`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `File op failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  private sandboxPath(path: string): string | null {
    const resolved = isAbsolute(path) ? path : resolve(this.config.workspaceRoot, path);
    const rel = relative(this.config.workspaceRoot, resolved);
    if (rel.startsWith('..')) return null; // Escapes workspace
    return resolved;
  }

  private async read(path: string, start: number): Promise<ToolResult> {
    if (!existsSync(path)) {
      return { success: false, data: null, summary: `File not found: ${path}`, error: 'NotFound', durationMs: Date.now() - start, includeInContext: false };
    }
    const stats = statSync(path);
    if (stats.size > this.config.maxReadSize) {
      return { success: false, data: null, summary: `File too large: ${stats.size} bytes (max ${this.config.maxReadSize})`, error: 'TooLarge', durationMs: Date.now() - start, includeInContext: false };
    }
    const content = readFileSync(path, 'utf-8');
    return { success: true, data: { path, content, size: stats.size }, summary: `Read ${path} (${stats.size} bytes)`, durationMs: Date.now() - start, includeInContext: true };
  }

  private async write(path: string, content: string, start: number): Promise<ToolResult> {
    if (!this.config.allowWrite) {
      return { success: false, data: null, summary: 'Write operations disabled', error: 'WriteDisabled', durationMs: Date.now() - start, includeInContext: false };
    }
    // Create parent dirs
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
    return { success: true, data: { path, bytes: content.length }, summary: `Wrote ${path} (${content.length} bytes)`, durationMs: Date.now() - start, includeInContext: true };
  }

  private async list(path: string, start: number): Promise<ToolResult> {
    if (!existsSync(path)) {
      return { success: false, data: null, summary: `Directory not found: ${path}`, error: 'NotFound', durationMs: Date.now() - start, includeInContext: false };
    }
    const entries = readdirSync(path, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? statSync(join(path, e.name)).size : 0,
    }));
    return { success: true, data: { path, entries }, summary: `Listed ${path} (${entries.length} entries)`, durationMs: Date.now() - start, includeInContext: true };
  }

  private async search(path: string, pattern: string, start: number): Promise<ToolResult> {
    if (!existsSync(path)) {
      return { success: false, data: null, summary: `Directory not found: ${path}`, error: 'NotFound', durationMs: Date.now() - start, includeInContext: false };
    }
    const regex = new RegExp(pattern, 'i');
    const matches: { file: string; line: number; text: string }[] = [];
    this.searchRecursive(path, regex, matches, 100);
    return { success: true, data: { pattern, matches }, summary: `Found ${matches.length} matches for /${pattern}/`, durationMs: Date.now() - start, includeInContext: true };
  }

  private searchRecursive(dir: string, regex: RegExp, matches: { file: string; line: number; text: string }[], max: number) {
    if (matches.length >= max) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= max) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          this.searchRecursive(fullPath, regex, matches, max);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') || entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < max; i++) {
            if (regex.test(lines[i])) {
              matches.push({ file: fullPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
            }
          }
        } catch { /* skip binary/unreadable */ }
      }
    }
  }
}