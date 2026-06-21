/**
 * Lodestone Tool — Transcribe
 *
 * Audio/video to text transcription.
 * Uses OpenAI Whisper API if OPENAI_API_KEY is set, falls back to local whisper CLI.
 * Supports local files and remote URLs.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { writeFile, mkdtempSync, rmSync } from 'fs';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(writeFile);

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
  duration: number;
}

export class TranscribeTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'transcribe',
    name: 'Audio/Video Transcription',
    description: 'Transcribe audio or video files to text. Uses OpenAI Whisper API or local whisper CLI. Supports text, SRT, and VTT output formats.',
    parameters: [
      { name: 'path', type: 'string', description: 'File path relative to workspace or URL', required: true },
      { name: 'language', type: 'string', description: 'ISO 639-1 language code (default: en)', required: false, default: 'en' },
      { name: 'model', type: 'string', description: 'Whisper model size: tiny, base, small, medium, large (default: base)', required: false, default: 'base' },
      { name: 'outputFormat', type: 'string', description: 'Output format: text, srt, or vtt', required: false, enum: ['text', 'srt', 'vtt'], default: 'text' },
    ],
    sideEffects: false,
    requiresApproval: false,
    timeout: 120000,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const inputPath = params.path as string;
    const language = (params.language as string) || 'en';
    const model = (params.model as string) || 'base';
    const outputFormat = (params.outputFormat as string) || 'text';
    const start = Date.now();

    if (!inputPath) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: path',
        error: 'path is required',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const isUrl = inputPath.startsWith('http://') || inputPath.startsWith('https://');
    let localPath: string;
    let cleanupTemp: string | null = null;

    try {
      // Resolve file
      if (isUrl) {
        const tempDir = mkdtempSync(join(tmpdir(), 'lodestone-transcribe-'));
        cleanupTemp = tempDir;
        const ext = this.guessExtension(inputPath);
        localPath = join(tempDir, `input${ext}`);
        await this.downloadFile(inputPath, localPath);
      } else {
        localPath = inputPath.startsWith('/') ? inputPath : join(context.workspaceRoot, inputPath);
      }

      if (!existsSync(localPath)) {
        if (cleanupTemp) this.cleanup(cleanupTemp);
        return {
          success: false,
          data: null,
          summary: `File not found: ${localPath}`,
          error: `File does not exist: ${localPath}`,
          durationMs: Date.now() - start,
          includeInContext: false,
        };
      }

      // Try OpenAI Whisper API first
      let result: TranscribeResult;

      if (process.env.OPENAI_API_KEY) {
        result = await this.transcribeWithOpenAI(localPath, language);
      } else {
        // Fall back to local whisper CLI
        result = await this.transcribeWithLocalWhisper(localPath, language, model);
      }

      if (cleanupTemp) this.cleanup(cleanupTemp);

      // Format output
      let formattedText: string;
      switch (outputFormat) {
        case 'srt':
          formattedText = this.toSRT(result.segments);
          break;
        case 'vtt':
          formattedText = this.toVTT(result.segments);
          break;
        default:
          formattedText = result.text;
      }

      return {
        success: true,
        data: {
          text: formattedText,
          segments: outputFormat === 'text' ? result.segments : undefined,
          language: result.language,
          duration: result.duration,
          format: outputFormat,
        },
        summary: `Transcribed ${inputPath}: ${result.text.length} chars, ${result.duration.toFixed(1)}s duration`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      if (cleanupTemp) this.cleanup(cleanupTemp);
      return {
        success: false,
        data: null,
        summary: `Transcription failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── OpenAI Whisper API ─────────────────────────────────────────────────────

  private async transcribeWithOpenAI(filePath: string, language: string): Promise<TranscribeResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Audio transcription via the Whisper API requires OPENAI_API_KEY. Set it in your environment or config.');

    const buffer = await readFile(filePath);
    const filename = filePath.split('/').pop() || 'audio.wav';

    const formData = new FormData();
    formData.append('file', new Blob([buffer]), filename);
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    formData.append('response_format', 'verbose_json');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI Whisper API transcription failed (HTTP ${res.status}): ${body}. Check API key validity and quota.`);
    }

    const data = await res.json() as {
      text: string;
      language: string;
      duration: number;
      segments?: Array<{ id: number; start: number; end: number; text: string }>;
    };

    const segments: TranscriptSegment[] = (data.segments || []).map(s => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    return {
      text: data.text.trim(),
      segments,
      language: data.language || language,
      duration: data.duration || 0,
    };
  }

  // ─── Local Whisper CLI ──────────────────────────────────────────────────────

  private async transcribeWithLocalWhisper(filePath: string, language: string, model: string): Promise<TranscribeResult> {
    // Check if whisper CLI is available
    try {
      await execFileAsync('which', ['whisper'], { timeout: 5000 });
    } catch {
      throw new Error(
        'No transcription method available. Either:\n' +
        '1. Set OPENAI_API_KEY to use the Whisper API\n' +
        '2. Install the whisper CLI: pip install openai-whisper'
      );
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'lodestone-whisper-out-'));
    try {
      const args = [
        filePath,
        '--model', model,
        '--language', language,
        '--output_format', 'json',
        '--output_dir', tempDir,
      ];

      await execFileAsync('whisper', args, { timeout: 110000 });

      // Read the JSON output
      const { readdir } = await import('fs/promises');
      const files = (await readdir(tempDir)).filter(f => f.endsWith('.json'));

      if (files.length === 0) {
        throw new Error('Whisper CLI ran but produced no output files. Check that the audio file is valid and the model can transcribe it.');
      }

      const { readFile: readFileAsync } = await import('fs/promises');
      const outputPath = join(tempDir, files[0]);
      const output = JSON.parse(await readFileAsync(outputPath, 'utf-8')) as {
        text: string;
        language?: string;
        segments?: Array<{ start: number; end: number; text: string }>;
      };

      const segments: TranscriptSegment[] = (output.segments || []).map(s => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      }));

      // Estimate duration from last segment
      const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

      return {
        text: output.text.trim(),
        segments,
        language: output.language || language,
        duration,
      };
    } finally {
      this.cleanup(tempDir);
    }
  }

  // ─── Format Helpers ─────────────────────────────────────────────────────────

  private formatTimestamp(seconds: number, separator: string): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}${separator}${String(mins).padStart(2, '0')}${separator}${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }
    return `00${separator}${String(mins).padStart(2, '0')}${separator}${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  private toSRT(segments: TranscriptSegment[]): string {
    return segments.map((seg, i) => {
      return `${i + 1}\n${this.formatTimestamp(seg.start, ':')},${this.formatTimestamp(seg.start, ':').split('.')[0]}` +
        ` --> ${this.formatTimestamp(seg.end, ':')},${this.formatTimestamp(seg.end, ':').split('.')[0]}\n${seg.text}\n`;
    }).join('\n');
  }

  private toVTT(segments: TranscriptSegment[]): string {
    const header = 'WEBVTT\n\n';
    const body = segments.map((seg, i) => {
      return `${i + 1}\n${this.formatTimestamp(seg.start, '.')}` +
        ` --> ${this.formatTimestamp(seg.end, '.')}\n${seg.text}\n`;
    }).join('\n');
    return header + body;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFileAsync(destPath, buffer);
  }

  private guessExtension(url: string): string {
    const urlPath = new URL(url).pathname;
    const ext = urlPath.split('.').pop()?.toLowerCase() || '';
    const audioVideoExts = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm', 'mp4', 'mov', 'avi', 'mkv'];
    if (audioVideoExts.includes(ext)) {
      return `.${ext}`;
    }
    return '.wav'; // Default
  }

  private cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}