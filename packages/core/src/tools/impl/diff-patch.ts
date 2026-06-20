/**
 * Lodestone Tool — Diff Patch
 *
 * Apply structured find-and-replace edits to files within the workspace.
 * Each edit's oldText must be unique in the file. Supports dry-run preview.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface DiffPatchConfig {
  /** Workspace root — file paths are sandboxed to this directory */
  workspaceRoot: string;
}

interface PatchEdit {
  oldText: string;
  newText: string;
}

export class DiffPatchTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'diff-patch',
    name: 'Diff Patch',
    description: 'Apply structured find-and-replace edits to a file. Each edit must match unique text. Supports dry-run preview.',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root)', required: true },
      { name: 'edits', type: 'array', description: 'Array of edits to apply (each edit has oldText and newText)', required: true, items: { name: 'edit', type: 'object', description: 'Edit with oldText and newText', required: true } },
      { name: 'dryRun', type: 'boolean', description: 'Preview changes without writing (default: false)', required: false, default: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 10000,
  };

  private config: DiffPatchConfig;

  constructor(config: DiffPatchConfig) {
    this.config = config;
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const filePath = params.path as string;
    const edits = params.edits as PatchEdit[];
    const dryRun = (params.dryRun as boolean) ?? false;
    const start = Date.now();

    // Sandbox path
    const safePath = this.sandboxPath(filePath);
    if (!safePath) {
      return {
        success: false,
        data: null,
        summary: `Path escapes workspace: ${filePath}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return {
        success: false,
        data: null,
        summary: 'No edits provided',
        error: 'MissingEdits',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (!existsSync(safePath)) {
      return {
        success: false,
        data: null,
        summary: `File not found: ${filePath}`,
        error: 'NotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    try {
      let content = readFileSync(safePath, 'utf-8');
      let applied = 0;
      let skipped = 0;
      const previewLines: string[] = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit.oldText || typeof edit.oldText !== 'string') {
          previewLines.push(`Edit ${i + 1}: skipped (no oldText)`);
          skipped++;
          continue;
        }

        // Check uniqueness
        const occurrences = content.split(edit.oldText).length - 1;
        if (occurrences === 0) {
          previewLines.push(`Edit ${i + 1}: skipped (oldText not found)`);
          skipped++;
          continue;
        }
        if (occurrences > 1) {
          previewLines.push(`Edit ${i + 1}: skipped (oldText found ${occurrences} times — must be unique)`);
          skipped++;
          continue;
        }

        // Apply edit
        content = content.replace(edit.oldText, edit.newText ?? '');
        previewLines.push(`Edit ${i + 1}: applied (${edit.oldText.slice(0, 40)}... → ${edit.newText?.slice(0, 40) ?? ''}...)`);
        applied++;
      }

      // Write unless dry run
      if (!dryRun && applied > 0) {
        writeFileSync(safePath, content);
      }

      const preview = previewLines.join('\n');

      return {
        success: true,
        data: {
          path: filePath,
          applied,
          skipped,
          dryRun,
          preview,
        },
        summary: `${dryRun ? 'Previewed' : 'Applied'} ${applied} edit(s), skipped ${skipped} (${filePath})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Diff patch failed: ${err}`,
        error: String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private sandboxPath(path: string): string | null {
    const resolved = isAbsolute(path) ? path : resolve(this.config.workspaceRoot, path);
    const rel = relative(this.config.workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }
}