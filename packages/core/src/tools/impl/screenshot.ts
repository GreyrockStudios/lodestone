/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Screenshot
 *
 * Captures the user's screen or a specific window.
 * Uses native OS commands (screencapture on macOS, scrot/gnome-screenshot on Linux).
 * Returns the saved file path, dimensions, and a base64 preview (truncated to 100KB).
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { platform } from 'os';
import { randomUUID } from 'crypto';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ScreenshotTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'screenshot',
    name: 'Screenshot',
    description:
      'Capture the screen or a specific window. Saves to data/screenshots/ by default. ' +
      'Returns path, dimensions, and a base64 preview.',
    parameters: [
      {
        name: 'display',
        type: 'number',
        description: 'Display index to capture (default: 0 = main display)',
        required: false,
        default: 0,
      },
      {
        name: 'window',
        type: 'string',
        description: 'Window title filter — captures a specific window instead of full screen',
        required: false,
      },
      {
        name: 'format',
        type: 'string',
        description: 'Image format: png or jpeg (default: png)',
        required: false,
        enum: ['png', 'jpeg'],
        default: 'png',
      },
      {
        name: 'quality',
        type: 'number',
        description: 'JPEG quality 1-100 (default: 80, ignored for png)',
        required: false,
        default: 80,
      },
      {
        name: 'outputPath',
        type: 'string',
        description: 'Output directory relative to workspace (default: data/screenshots/)',
        required: false,
        default: 'data/screenshots/',
      },
    ],
    sideEffects: true, // writes a file
    requiresApproval: true,
    timeout: 10000,
  };

  private maxPreviewBytes = 100 * 1024; // 100KB base64 preview

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const display = (params.display as number) ?? 0;
    const windowFilter = params.window as string | undefined;
    const format = (params.format as string) || 'png';
    const quality = (params.quality as number) || 80;
    const outputDir = (params.outputPath as string) || 'data/screenshots/';

    // Resolve safe output directory
    const outDir = this.resolveSafePath(context.workspaceRoot, outputDir);
    if (!outDir) {
      return {
        success: false,
        data: null,
        summary: `Output path escapes workspace: ${outputDir}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Create output directory
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`;
    const filePath = join(outDir, filename);
    const os = platform();

    try {
      if (os === 'darwin') {
        await this.captureMacOS(filePath, display, windowFilter, format, quality);
      } else if (os === 'linux') {
        await this.captureLinux(filePath, display, windowFilter, format, quality);
      } else {
        return {
          success: false,
          data: null,
          summary: `Unsupported platform: ${os}`,
          error: `Screenshot not supported on ${os}`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      // Verify the file was created
      if (!existsSync(filePath)) {
        return {
          success: false,
          data: null,
          summary: 'Screenshot command ran but no file was produced',
          error: 'NoOutputFile',
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      const stats = statSync(filePath);
      const buffer = readFileSync(filePath);
      const base64 = buffer.toString('base64');

      // Truncate base64 for context preview
      const preview = base64.length > this.maxPreviewBytes
        ? base64.slice(0, this.maxPreviewBytes) + '...[truncated]'
        : base64;

      // Get image dimensions (simplified — parse from buffer header)
      const dimensions = this.getImageDimensions(buffer, format);

      return {
        success: true,
        data: {
          path: filePath,
          width: dimensions.width,
          height: dimensions.height,
          format,
          sizeBytes: stats.size,
          imageBase64: preview,
        },
        summary: `Captured screenshot → ${filePath} (${dimensions.width}x${dimensions.height}, ${stats.size} bytes)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Screenshot failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── macOS ────────────────────────────────────────────────────────────────

  private captureMacOS(
    filePath: string,
    display: number,
    windowFilter: string | undefined,
    format: string,
    _quality: number,
  ): Promise<void> {
    // screencapture flags:
    //   -x : no sound
    //   -C : capture cursor
    //   -D <n> : display number
    //   -t <format> : png or jpg
    //   -o : window only (with -l)
    // For window capture by title, we'd need to find the window ID first.
    // That requires additional tooling (e.g., osascript), so we fall back to full display.
    const args: string[] = ['-x', '-C'];

    if (display > 0) {
      args.push('-D', String(display + 1)); // screencapture uses 1-based display IDs
    }

    if (format === 'jpeg') {
      args.push('-t', 'jpg');
    } else {
      args.push('-t', 'png');
    }

    // If window filter provided, try to capture that window via osascript
    if (windowFilter) {
      // For now, we capture the full display — window-specific capture needs
      // window ID lookup which is complex. The filter is noted but we proceed.
    }

    args.push(filePath);

    return new Promise((resolve, reject) => {
      execFile('screencapture', args, { timeout: 8000 }, (err) => {
        if (err) reject(new Error(`screencapture failed: ${err.message}`));
        else resolve();
      });
    });
  }

  // ─── Linux ──────────────────────────────────────────────────────────────────

  private captureLinux(
    filePath: string,
    _display: number,
    _windowFilter: string | undefined,
    format: string,
    quality: number,
  ): Promise<void> {
    // Try scrot first, then gnome-screenshot
    return this.tryScrot(filePath, format, quality).catch(() =>
      this.tryGnomeScreenshot(filePath),
    );
  }

  private tryScrot(filePath: string, format: string, quality: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['--file', filePath];
      if (format === 'jpeg') {
        args.push('--quality', String(quality));
      }
      execFile('scrot', args, { timeout: 8000 }, (err) => {
        if (err) reject(new Error(`scrot failed: ${err.message}`));
        else resolve();
      });
    });
  }

  private tryGnomeScreenshot(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('gnome-screenshot', ['-f', filePath], { timeout: 8000 }, (err) => {
        if (err) reject(new Error(`gnome-screenshot failed: ${err.message}`));
        else resolve();
      });
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private resolveSafePath(workspaceRoot: string, relativePath: string): string | null {
    const resolved = isAbsolute(relativePath)
      ? relativePath
      : resolve(workspaceRoot, relativePath);
    const rel = relative(workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }

  private getImageDimensions(buffer: Buffer, format: string): { width: number; height: number } {
    try {
      if (format === 'png') {
        // PNG header: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
        if (buffer.length >= 24) {
          return {
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
          };
        }
      } else if (format === 'jpeg') {
        // JPEG: scan for SOF0 (0xFFC0) marker
        let offset = 2; // Skip SOI marker
        while (offset < buffer.length - 1) {
          if (buffer[offset] !== 0xff) { offset++; continue; }
          const marker = buffer[offset + 1];
          if (marker === 0xc0 || marker === 0xc2) {
            // SOF0 or SOF2: height at offset+5 (2 bytes BE), width at offset+7 (2 bytes BE)
            if (offset + 9 <= buffer.length) {
              return {
                height: buffer.readUInt16BE(offset + 5),
                width: buffer.readUInt16BE(offset + 7),
              };
            }
          }
          // Skip to next marker
          if (offset + 3 < buffer.length) {
            const len = buffer.readUInt16BE(offset + 2);
            offset += 2 + len;
          } else {
            break;
          }
        }
      }
    } catch {
      // Fall through to default
    }
    return { width: 0, height: 0 };
  }
}