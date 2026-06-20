/**
 * Lodestone Tool — Archive (Zip)
 *
 * Compress, decompress, and list files in archives.
 * Supports zip, tar, and gz formats.
 * Uses lazy imports of `archiver` and `unzipper` / `tar` packages.
 *
 * Security:
 * - All paths are sandboxed to the workspace root.
 * - Password-protected zip creation is supported (zip format only).
 */

import { existsSync, mkdirSync, createWriteStream, createReadStream, statSync, readdirSync } from 'fs';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArchiveEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

// ─── Dynamic import helper (prevents TS from resolving uninstalled modules) ───

async function dynamicImport(moduleName: string): Promise<unknown> {
  return await import(/* @vite-ignore */ moduleName as string);
}

// Minimal type interfaces for optional dependencies (archiver, unzipper)
interface ArchiverInstance {
  pipe(stream: NodeJS.WritableStream): void;
  file(path: string, opts: { name: string }): void;
  directory(path: string, destPath: string): void;
  finalize(): Promise<void> | void;
  on(event: string, handler: (err: Error) => void): void;
}

interface UnzipperModule {
  Extract(opts: { path: string }): NodeJS.WritableStream;
  Parse(): NodeJS.ReadWriteStream;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ArchiveTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'archive',
    name: 'Archive',
    description:
      'Compress, decompress, or list files in archives. ' +
      'Supports zip, tar, and gz formats. Password-protected zip creation supported.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: compress, decompress, or list',
        required: true,
        enum: ['compress', 'decompress', 'list'],
      },
      {
        name: 'path',
        type: 'string',
        description: 'Source path (relative to workspace). For compress: file/dir to archive. For decompress/list: archive file.',
        required: true,
      },
      {
        name: 'outputPath',
        type: 'string',
        description: 'Output path for compressed file (default: <path>.<format>). For decompress: output directory (default: directory of archive).',
        required: false,
      },
      {
        name: 'format',
        type: 'string',
        description: 'Archive format: zip, tar, or gz (default: zip)',
        required: false,
        enum: ['zip', 'tar', 'gz'],
        default: 'zip',
      },
      {
        name: 'password',
        type: 'string',
        description: 'Password for zip encryption (compress only)',
        required: false,
      },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 60000,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const action = params.action as string;
    const path = params.path as string;
    const format = (params.format as string) || 'zip';
    const password = params.password as string | undefined;

    // Sandbox the source path
    const safePath = this.sandboxPath(context.workspaceRoot, path);
    if (!safePath) {
      return {
        success: false,
        data: null,
        summary: `Source path escapes workspace: ${path}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (!existsSync(safePath)) {
      return {
        success: false,
        data: null,
        summary: `Source not found: ${path}`,
        error: 'NotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    try {
      switch (action) {
        case 'compress': {
          const outputPath = (params.outputPath as string) || `${safePath}.${format}`;
          const safeOutput = this.sandboxPath(context.workspaceRoot, outputPath) || outputPath;
          return await this.compress(safePath, safeOutput, format, password, start);
        }
        case 'decompress': {
          const outputDir = (params.outputPath as string) || dirname(safePath);
          const safeOutput = this.sandboxPath(context.workspaceRoot, outputDir) || outputDir;
          return await this.decompress(safePath, safeOutput, format, start);
        }
        case 'list':
          return await this.listContents(safePath, format, start);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: compress, decompress, list',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Archive operation failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Compress ──────────────────────────────────────────────────────────────

  private async compress(
    sourcePath: string,
    outputPath: string,
    format: string,
    password: string | undefined,
    start: number,
  ): Promise<ToolResult> {
    // Ensure output directory exists
    const outDir = dirname(outputPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const isDir = statSync(sourcePath).isDirectory();
    let entryCount = 0;

    if (format === 'zip') {
      // Lazy import archiver (optional dependency — not in package.json)
      let archiver: (format: string, opts: Record<string, unknown>) => ArchiverInstance;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        archiver = ((await dynamicImport('archiver')) as { default: unknown }).default as unknown as (format: string, opts: Record<string, unknown>) => ArchiverInstance;
      } catch {
        return {
          success: false,
          data: null,
          summary: 'archiver package not installed. Run: npm install archiver',
          error: 'MissingDependency: archiver',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 6 },
        ...(password ? { password } : {}),
      });

      const finished = new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
      });

      archive.pipe(output);

      if (isDir) {
        const entries = readdirSync(sourcePath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(sourcePath, entry.name);
          if (entry.isDirectory()) {
            archive.directory(fullPath, entry.name);
          } else {
            archive.file(fullPath, { name: entry.name });
          }
          entryCount++;
        }
      } else {
        archive.file(sourcePath, { name: basename(sourcePath) });
        entryCount = 1;
      }

      await archive.finalize();
      await finished;

      const size = statSync(outputPath).size;
      return {
        success: true,
        data: { path: outputPath, entries: entryCount, size, format },
        summary: `Compressed ${entryCount} entries → ${outputPath} (${this.formatBytes(size)})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else if (format === 'tar' || format === 'gz') {
      // Use tar CLI for tar/gz
      const ext = format === 'gz' ? '.tar.gz' : '.tar';
      const tarOutput = outputPath.endsWith(ext) ? outputPath : `${outputPath}${ext === '.tar.gz' ? '' : ''}`;
      const args = isDir
        ? ['-cf', tarOutput, '-C', dirname(sourcePath), basename(sourcePath)]
        : ['-cf', tarOutput, '-C', dirname(sourcePath), basename(sourcePath)];

      if (format === 'gz') {
        args.splice(1, 0, '-z');
      }

      await execFileAsync('tar', args, { timeout: 55000 });

      // Count entries
      const listArgs = ['-tf', tarOutput];
      const { stdout } = await execFileAsync('tar', listArgs);
      entryCount = stdout.trim().split('\n').filter(Boolean).length;

      const size = statSync(tarOutput).size;
      return {
        success: true,
        data: { path: tarOutput, entries: entryCount, size, format },
        summary: `Compressed ${entryCount} entries → ${tarOutput} (${this.formatBytes(size)})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else {
      return {
        success: false,
        data: null,
        summary: `Unsupported format: ${format}`,
        error: 'Supported formats: zip, tar, gz',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Decompress ─────────────────────────────────────────────────────────────

  private async decompress(
    archivePath: string,
    outputDir: string,
    format: string,
    start: number,
  ): Promise<ToolResult> {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    // Detect actual format from file extension if not specified
    const detectedFormat = this.detectFormat(archivePath, format);

    if (detectedFormat === 'zip') {
      // Lazy import unzipper (optional dependency)
      let unzipper: UnzipperModule;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unzipper = ((await dynamicImport('unzipper')) as { default: unknown }).default as unknown as UnzipperModule;
      } catch {
        return {
          success: false,
          data: null,
          summary: 'unzipper package not installed. Run: npm install unzipper',
          error: 'MissingDependency: unzipper',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      const stream = createReadStream(archivePath).pipe(unzipper.Extract({ path: outputDir }));
      await new Promise<void>((resolve, reject) => {
        stream.on('close', () => resolve());
        stream.on('error', reject);
      });

      // Count extracted files
      const entries = this.countFiles(outputDir);
      return {
        success: true,
        data: { path: outputDir, entries, format: 'zip' },
        summary: `Extracted ${entries} entries → ${outputDir}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else if (detectedFormat === 'tar' || detectedFormat === 'gz') {
      const args = ['-xf', archivePath, '-C', outputDir];
      await execFileAsync('tar', args, { timeout: 55000 });

      const entries = this.countFiles(outputDir);
      return {
        success: true,
        data: { path: outputDir, entries, format: detectedFormat },
        summary: `Extracted ${entries} entries → ${outputDir}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else {
      return {
        success: false,
        data: null,
        summary: `Unsupported archive format: ${detectedFormat}`,
        error: `Cannot determine archive format for ${archivePath}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  private async listContents(
    archivePath: string,
    format: string,
    start: number,
  ): Promise<ToolResult> {
    const detectedFormat = this.detectFormat(archivePath, format);

    if (detectedFormat === 'zip') {
      let unzipper: UnzipperModule;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unzipper = ((await dynamicImport('unzipper')) as { default: unknown }).default as unknown as UnzipperModule;
      } catch {
        return {
          success: false,
          data: null,
          summary: 'unzipper package not installed. Run: npm install unzipper',
          error: 'MissingDependency: unzipper',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      const entries: ArchiveEntry[] = [];
      const stream = createReadStream(archivePath).pipe(unzipper.Parse());

      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream.on('entry', (entry: any) => {
          entries.push({
            name: entry.path as string,
            type: entry.type === 'Directory' ? 'directory' : 'file',
            size: entry.vars?.uncompressedSize || 0,
          });
          // autodrain is a method on unzipper entries
          if (typeof entry.autodrain === 'function') {
            entry.autodrain();
          }
        });
        stream.on('close', () => resolve());
        stream.on('error', reject);
      });

      return {
        success: true,
        data: { path: archivePath, entries, count: entries.length },
        summary: `Listed ${entries.length} entries in ${archivePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else if (detectedFormat === 'tar' || detectedFormat === 'gz') {
      const { stdout } = await execFileAsync('tar', ['-tf', archivePath]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const entries: ArchiveEntry[] = lines.map((line) => ({
        name: line,
        type: line.endsWith('/') ? 'directory' : 'file',
        size: 0, // tar -tf doesn't give sizes without -v
      }));

      return {
        success: true,
        data: { path: archivePath, entries, count: entries.length },
        summary: `Listed ${entries.length} entries in ${archivePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } else {
      return {
        success: false,
        data: null,
        summary: `Unsupported archive format: ${detectedFormat}`,
        error: `Cannot determine archive format for ${archivePath}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private sandboxPath(workspaceRoot: string, path: string): string | null {
    const resolved = isAbsolute(path) ? path : resolve(workspaceRoot, path);
    const rel = relative(workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }

  private detectFormat(filePath: string, declared: string): string {
    if (declared !== 'zip' && declared !== 'tar' && declared !== 'gz') {
      // Auto-detect from extension
      if (filePath.endsWith('.zip')) return 'zip';
      if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) return 'gz';
      if (filePath.endsWith('.tar')) return 'tar';
      if (filePath.endsWith('.gz')) return 'gz';
    }
    return declared;
  }

  private countFiles(dir: string): number {
    let count = 0;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += this.countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}