/**
 * Lodestone Tool — Diff Patch
 *
 * Apply structured find-and-replace edits to files within the workspace.
 * Each edit's oldText must be unique in the file. Supports dry-run preview.
 * Supports multi-file patches via `multiFileEdits` parameter.
 * Supports standard unified diff format via `patch` parameter.
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

interface MultiFileEdit {
  path: string;
  edits: PatchEdit[];
}

interface ParsedDiffFile {
  path: string;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: string[];
}

export class DiffPatchTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'diff-patch',
    name: 'Diff Patch',
    description: 'Apply structured find-and-replace edits to files. Each edit must match unique text. Supports dry-run preview, multi-file edits, and unified diff patches.',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to workspace root) — for single-file edits', required: false },
      { name: 'edits', type: 'array', description: 'Array of edits to apply to a single file (each edit has oldText and newText)', required: false, items: { name: 'edit', type: 'object', description: 'Edit with oldText and newText', required: true } },
      { name: 'multiFileEdits', type: 'array', description: 'Array of {path, edits} for multi-file patches', required: false, items: { name: 'fileEdit', type: 'object', description: 'File edit with path and edits array', required: true } },
      { name: 'patch', type: 'string', description: 'Unified diff string to apply across multiple files (standard diff format with --- /+++ headers)', required: false },
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
    const start = Date.now();
    const dryRun = (params.dryRun as boolean) ?? false;

    // Determine mode: patch (unified diff), multiFileEdits, or single-file
    if (params.patch !== undefined && params.patch !== null) {
      return await this.applyUnifiedDiff(params.patch as string, dryRun, start);
    }

    if (params.multiFileEdits !== undefined && params.multiFileEdits !== null) {
      return await this.applyMultiFileEdits(params.multiFileEdits as MultiFileEdit[], dryRun, start);
    }

    // Default: single-file mode
    const filePath = params.path as string;
    const edits = params.edits as PatchEdit[];
    return await this.applySingleFile(filePath, edits, dryRun, start);
  }

  /**
   * Apply edits to a single file (original behavior, preserved for backward compat).
   */
  private async applySingleFile(
    filePath: string,
    edits: PatchEdit[],
    dryRun: boolean,
    start: number,
  ): Promise<ToolResult> {
    if (!filePath) {
      return {
        success: false,
        data: null,
        summary: 'No file path provided',
        error: 'MissingPath: path parameter is required for single-file edits. Example: {"path":"src/file.ts","edits":[...]}',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return {
        success: false,
        data: null,
        summary: 'No edits provided',
        error: 'MissingEdits: edits parameter is required and must be a non-empty array. Example: {"edits":[{"oldText":"foo","newText":"bar"}]}',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const safePath = this.sandboxPath(filePath);
    if (!safePath) {
      return {
        success: false,
        data: null,
        summary: `Path escapes workspace: ${filePath}`,
        error: `PathTraversalDenied: '${filePath}' resolves outside the workspace root.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (!existsSync(safePath)) {
      return {
        success: false,
        data: null,
        summary: `File not found: ${filePath}`,
        error: `NotFound: file '${filePath}' does not exist. Check the path and try again.`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    try {
      let content = readFileSync(safePath, 'utf-8');
      let applied = 0;
      let skipped = 0;
      const previewLines: string[] = [];

      const result = this.applyEditsToContent(content, edits);
      applied = result.applied;
      skipped = result.skipped;
      previewLines.push(...result.previewLines);

      // Write unless dry run
      if (!dryRun && applied > 0) {
        writeFileSync(safePath, result.content);
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
        summary: `Diff patch failed for ${filePath}: ${err}`,
        error: `PatchError: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  /**
   * Apply edits to multiple files in a single call.
   * Validates all files exist before applying any changes (atomic semantics).
   */
  private async applyMultiFileEdits(
    multiFileEdits: MultiFileEdit[],
    dryRun: boolean,
    start: number,
  ): Promise<ToolResult> {
    if (!Array.isArray(multiFileEdits) || multiFileEdits.length === 0) {
      return {
        success: false,
        data: null,
        summary: 'No multi-file edits provided',
        error: 'MissingMultiFileEdits: multiFileEdits parameter must be a non-empty array of {path, edits} objects.',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Validate all entries
    for (let i = 0; i < multiFileEdits.length; i++) {
      const entry = multiFileEdits[i];
      if (!entry.path || typeof entry.path !== 'string') {
        return {
          success: false,
          data: null,
          summary: `Multi-file edit ${i + 1} has invalid path`,
          error: `InvalidEntry: multiFileEdits[${i}] is missing a valid 'path' string.`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      if (!Array.isArray(entry.edits) || entry.edits.length === 0) {
        return {
          success: false,
          data: null,
          summary: `Multi-file edit ${i + 1} ('${entry.path}') has no edits`,
          error: `InvalidEntry: multiFileEdits[${i}] for path '${entry.path}' has no edits array or edits is empty.`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
    }

    // Sandbox and validate all paths first (atomic — don't modify any file if any is invalid)
    const resolvedFiles: Array<{ path: string; safePath: string; edits: PatchEdit[] }> = [];
    for (const entry of multiFileEdits) {
      const safePath = this.sandboxPath(entry.path);
      if (!safePath) {
        return {
          success: false,
          data: null,
          summary: `Path escapes workspace: ${entry.path}`,
          error: `PathTraversalDenied: '${entry.path}' resolves outside the workspace root. No files were modified.`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      if (!existsSync(safePath)) {
        return {
          success: false,
          data: null,
          summary: `File not found: ${entry.path}`,
          error: `NotFound: file '${entry.path}' does not exist. No files were modified (atomic validation).`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      resolvedFiles.push({ path: entry.path, safePath, edits: entry.edits });
    }

    // All files validated — now apply edits
    const results: Array<{
      path: string;
      applied: number;
      skipped: number;
      preview: string[];
    }> = [];

    let totalApplied = 0;
    let totalSkipped = 0;

    try {
      for (const file of resolvedFiles) {
        const content = readFileSync(file.safePath, 'utf-8');
        const result = this.applyEditsToContent(content, file.edits);

        if (!dryRun && result.applied > 0) {
          writeFileSync(file.safePath, result.content);
        }

        results.push({
          path: file.path,
          applied: result.applied,
          skipped: result.skipped,
          preview: result.previewLines,
        });
        totalApplied += result.applied;
        totalSkipped += result.skipped;
      }

      return {
        success: true,
        data: {
          files: results,
          totalApplied,
          totalSkipped,
          dryRun,
        },
        summary: `${dryRun ? 'Previewed' : 'Applied'} ${totalApplied} edit(s) across ${results.length} file(s), skipped ${totalSkipped}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Multi-file diff patch failed: ${err}`,
        error: `PatchError: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  /**
   * Apply a standard unified diff patch across multiple files.
   * Parses the diff format with `--- /path` and `+++ /path` headers and `@@` hunk markers.
   * Validates all files exist before applying any changes.
   */
  private async applyUnifiedDiff(
    patch: string,
    dryRun: boolean,
    start: number,
  ): Promise<ToolResult> {
    if (!patch || patch.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: 'No patch content provided',
        error: 'MissingPatch: patch parameter is required and must be a non-empty unified diff string.',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Parse the unified diff
    let parsedFiles: ParsedDiffFile[];
    try {
      parsedFiles = this.parseUnifiedDiff(patch);
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Failed to parse unified diff: ${err}`,
        error: `ParseError: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    if (parsedFiles.length === 0) {
      return {
        success: false,
        data: null,
        summary: 'No file changes found in patch',
        error: 'EmptyPatch: the patch string contains no file headers (--- /+++). Expected format: --- a/path\\n+++ b/path\\n@@ ...',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Validate all files exist first (atomic)
    const resolvedFiles: Array<{ path: string; safePath: string; parsed: ParsedDiffFile }> = [];
    for (const parsed of parsedFiles) {
      const safePath = this.sandboxPath(parsed.path);
      if (!safePath) {
        return {
          success: false,
          data: null,
          summary: `Path escapes workspace: ${parsed.path}`,
          error: `PathTraversalDenied: '${parsed.path}' resolves outside the workspace root. No files were modified.`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      if (!existsSync(safePath)) {
        return {
          success: false,
          data: null,
          summary: `File not found: ${parsed.path}`,
          error: `NotFound: file '${parsed.path}' does not exist. No files were modified (atomic validation).`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }
      resolvedFiles.push({ path: parsed.path, safePath, parsed });
    }

    // Apply hunks to each file
    const results: Array<{ path: string; applied: number; skipped: number }> = [];
    let totalApplied = 0;
    let totalSkipped = 0;

    try {
      for (const file of resolvedFiles) {
        const content = readFileSync(file.safePath, 'utf-8');
        const result = this.applyHunks(content, file.parsed.hunks);

        if (!dryRun && result.applied > 0) {
          writeFileSync(file.safePath, result.content);
        }

        results.push({ path: file.path, applied: result.applied, skipped: result.skipped });
        totalApplied += result.applied;
        totalSkipped += result.skipped;
      }

      return {
        success: true,
        data: {
          files: results,
          totalApplied,
          totalSkipped,
          dryRun,
          patchFormat: 'unified-diff',
        },
        summary: `${dryRun ? 'Previewed' : 'Applied'} ${totalApplied} hunk(s) across ${results.length} file(s), skipped ${totalSkipped}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Unified diff patch failed: ${err}`,
        error: `PatchError: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  /**
   * Parse a unified diff string into structured file/hunk data.
   * Supports standard format:
   *   --- a/path/to/file
   *   +++ b/path/to/file
   *   @@ -oldStart,oldLen +newStart,newLen @@
   *   -removed line
   *   +added line
   *    context line
   */
  private parseUnifiedDiff(patch: string): ParsedDiffFile[] {
    const lines = patch.split('\n');
    const files: ParsedDiffFile[] = [];
    let currentFile: ParsedDiffFile | null = null;
    let currentHunk: ParsedHunk | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        // Start of a new file diff
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        if (currentFile) {
          files.push(currentFile);
        }
        // Extract path — strip prefix like 'a/' if present
        const oldPath = line.slice(4).trim();
        currentFile = { path: this.stripPrefix(oldPath), hunks: [] };
      } else if (line.startsWith('+++ ')) {
        // We already have currentFile from the --- line
        if (!currentFile) {
          throw new Error(`+++ header without preceding --- header at line ${i + 1}`);
        }
        const newPath = line.slice(4).trim();
        // Prefer the +++ path if it differs from --- (rename case), otherwise keep --- path
        // If +++ path has a different base name, it's a rename — use +++ path
        const strippedNew = this.stripPrefix(newPath);
        // Keep the --- path as the file to modify (it's the original file)
        // If paths differ (a/file → b/file), they should be the same after stripping prefix
      } else if (line.startsWith('@@')) {
        // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@
        if (!currentFile) {
          throw new Error(`Hunk header without file header at line ${i + 1}`);
        }
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
        }
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!match) {
          throw new Error(`Invalid hunk header at line ${i + 1}: '${line}'`);
        }
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLen: match[2] ? parseInt(match[2], 10) : 1,
          newStart: match[3] ? parseInt(match[3], 10) : 1,
          newLen: match[4] ? parseInt(match[4], 10) : 1,
          lines: [],
        };
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        // Hunk content line
        if (!currentHunk) {
          // Ignore stray content lines outside hunks
          continue;
        }
        currentHunk.lines.push(line);
      } else if (line.trim() === '' || line.startsWith('\\ No newline')) {
        // Ignore empty lines and no-newline markers
        continue;
      }
    }

    // Finalize last hunk and file
    if (currentHunk && currentFile) {
      currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }

  /**
   * Strip the a/ or b/ prefix from a diff path.
   */
  private stripPrefix(path: string): string {
    if (path.startsWith('a/') || path.startsWith('b/')) {
      return path.slice(2);
    }
    return path;
  }

  /**
   * Apply parsed hunks to file content.
   * Uses find-and-replace approach: extract old text from hunk, find it in content, replace with new text.
   */
  private applyHunks(
    content: string,
    hunks: ParsedHunk[],
  ): { content: string; applied: number; skipped: number } {
    let currentContent = content;
    let applied = 0;
    let skipped = 0;

    for (const hunk of hunks) {
      // Build old text (removed + context lines) and new text (added + context lines)
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of hunk.lines) {
        if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
        }
      }

      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');

      // If oldText and newText are the same, nothing to do
      if (oldText === newText) {
        skipped++;
        continue;
      }

      // Check uniqueness
      const occurrences = currentContent.split(oldText).length - 1;
      if (occurrences === 0) {
        skipped++;
        continue;
      }
      if (occurrences > 1) {
        skipped++;
        continue;
      }

      currentContent = currentContent.replace(oldText, newText);
      applied++;
    }

    return { content: currentContent, applied, skipped };
  }

  /**
   * Apply a set of edits to file content. Shared between single-file and multi-file modes.
   */
  private applyEditsToContent(
    content: string,
    edits: PatchEdit[],
  ): { content: string; applied: number; skipped: number; previewLines: string[] } {
    let result = content;
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
      const occurrences = result.split(edit.oldText).length - 1;
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
      result = result.replace(edit.oldText, edit.newText ?? '');
      previewLines.push(`Edit ${i + 1}: applied (${edit.oldText.slice(0, 40)}... → ${edit.newText?.slice(0, 40) ?? ''}...)`);
      applied++;
    }

    return { content: result, applied, skipped, previewLines };
  }

  private sandboxPath(path: string): string | null {
    const resolved = isAbsolute(path) ? path : resolve(this.config.workspaceRoot, path);
    const rel = relative(this.config.workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }
}