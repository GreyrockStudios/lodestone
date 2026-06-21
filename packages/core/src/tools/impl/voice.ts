/**
 * Lodestone Tool — Voice
 *
 * Gives the agent voice capabilities: transcribe audio files and synthesize speech.
 * Two tools: `voice-transcribe` and `voice-speak`.
 *
 * No external dependencies — delegates to VoiceChannel for actual processing.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { Logger } from '../../utils/logger.js';
import { execFile } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Voice Tool Config ────────────────────────────────────────────────────────

export interface VoiceToolConfig {
  /** Speech-to-text provider */
  sttProvider?: 'whisper-api' | 'whisper-local' | 'system';
  /** STT configuration */
  sttConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    binaryPath?: string;
  };
  /** Text-to-speech provider */
  ttsProvider?: 'openai' | 'coqui' | 'system';
  /** TTS configuration */
  ttsConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
    binaryPath?: string;
    systemCommand?: string;
  };
  /** Temp directory for audio files */
  tempDir?: string;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SynthOpts {
  voice?: string;
  speed?: number;
  format?: 'mp3' | 'wav' | 'opus';
}

// ─── Voice Tool ─────────────────────────────────────────────────────────────

export class VoiceTool implements Tool {
  readonly definition: ToolDefinition;
  private logger: Logger;
  private config: VoiceToolConfig;
  private tempDir: string;

  constructor(config?: VoiceToolConfig) {
    this.config = config || {};
    this.logger = new Logger({ minLevel: 'info' });
    this.tempDir = config?.tempDir || join(process.cwd(), 'data/voice');

    // The VoiceTool exposes two sub-tools via a single execute() that dispatches on 'action'
    this.definition = {
      id: 'voice',
      name: 'Voice I/O',
      description: 'Transcribe audio files to text and synthesize speech from text. Actions: transcribe, speak.',
      parameters: [
        {
          name: 'action',
          description: 'transcribe (audio→text) or speak (text→audio)',
          type: 'string',
          required: true,
          enum: ['transcribe', 'speak'],
        },
        {
          name: 'audioPath',
          description: 'Path to the audio file to transcribe (for transcribe action)',
          type: 'string',
          required: false,
        },
        {
          name: 'text',
          description: 'Text to synthesize (for speak action)',
          type: 'string',
          required: false,
        },
        {
          name: 'voice',
          description: 'Voice name (provider-specific, e.g., "alloy" for OpenAI, "Samantha" for macOS)',
          type: 'string',
          required: false,
        },
        {
          name: 'speed',
          description: 'Speech speed multiplier 0.5–4.0 (default 1.0)',
          type: 'number',
          required: false,
        },
        {
          name: 'format',
          description: 'Output audio format for speak action',
          type: 'string',
          required: false,
          enum: ['mp3', 'wav', 'opus'],
        },
      ],
      sideEffects: true,
      requiresApproval: false,
      timeout: 30000,
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'transcribe':
          return await this.transcribe(params);

        case 'speak':
          return await this.speak(params);

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown voice action: ${action}`,
            error: 'Valid actions: transcribe, speak',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: 'Voice tool error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Transcribe ───────────────────────────────────────────────────────────

  private async transcribe(params: Record<string, unknown>): Promise<ToolResult> {
    const audioPath = params.audioPath as string;
    const start = Date.now();

    if (!audioPath) {
      return {
        success: false,
        data: null,
        summary: 'Missing audioPath parameter',
        error: 'audioPath is required for transcribe action',
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    if (!existsSync(audioPath)) {
      return {
        success: false,
        data: null,
        summary: `Audio file not found: ${audioPath}`,
        error: `File does not exist: ${audioPath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    const provider = this.config.sttProvider || 'system';
    this.logger.info(`[VoiceTool] Transcribing ${audioPath} via ${provider}`);

    try {
      let text: string;

      switch (provider) {
        case 'whisper-api':
          text = await this.transcribeWhisperAPI(audioPath);
          break;

        case 'whisper-local':
          text = await this.transcribeWhisperLocal(audioPath);
          break;

        case 'system':
          this.logger.warn('[VoiceTool] System STT not widely available, attempting whisper-local fallback');
          text = await this.transcribeWhisperLocal(audioPath);
          break;

        default:
          throw new Error(`Unknown STT provider '${provider}'. Supported: 'openai', 'whisper-local', 'system'.`);
      }

      return {
        success: true,
        data: { text, audioPath, provider },
        summary: `Transcribed ${audioPath}: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Transcription failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  private async transcribeWhisperAPI(audioPath: string): Promise<string> {
    const cfg = this.config.sttConfig || {};
    const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Whisper API transcription requires OPENAI_API_KEY. Set it in your environment or voice config.');

    const baseUrl = cfg.baseUrl || 'https://api.openai.com/v1';
    const model = cfg.model || 'whisper-1';

    const audioBuffer = await readFile(audioPath);
    const ext = audioPath.split('.').pop()?.toLowerCase() || 'wav';
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'opus' ? 'audio/opus' : ext === 'm4a' ? 'audio/mp4' : 'audio/wav';

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', model);

    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Whisper API transcription failed (HTTP ${res.status}): ${body}. Check API key validity and quota.`);
    }

    const data = await res.json() as { text: string };
    return data.text.trim();
  }

  private async transcribeWhisperLocal(audioPath: string): Promise<string> {
    const binary = this.config.sttConfig?.binaryPath || 'whisper';

    return new Promise((resolve, reject) => {
      execFile(binary, [audioPath, '--output_format', 'txt', '--output_dir', this.tempDir], (err, stdout) => {
        if (err) {
          reject(new Error(`Local whisper failed: ${err.message}`));
          return;
        }
        const baseName = audioPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'audio';
        const txtPath = join(this.tempDir, `${baseName}.txt`);
        readFile(txtPath, 'utf-8')
          .then(text => resolve(text.trim()))
          .catch(() => resolve(stdout.trim()));
      });
    });
  }

  // ─── Speak ──────────────────────────────────────────────────────────────────

  private async speak(params: Record<string, unknown>): Promise<ToolResult> {
    const text = params.text as string;
    const start = Date.now();

    if (!text) {
      return {
        success: false,
        data: null,
        summary: 'Missing text parameter',
        error: 'text is required for speak action',
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    const provider = this.config.ttsProvider || 'system';
    const opts: SynthOpts = {
      voice: params.voice as string | undefined,
      speed: params.speed as number | undefined,
      format: (params.format as 'mp3' | 'wav' | 'opus' | undefined) || 'mp3',
    };

    this.logger.info(`[VoiceTool] Synthesizing ${text.length} chars via ${provider}`);

    try {
      if (!existsSync(this.tempDir)) {
        await mkdir(this.tempDir, { recursive: true });
      }

      let audioBuffer: Buffer;

      switch (provider) {
        case 'openai':
          audioBuffer = await this.synthesizeOpenAI(text, opts);
          break;

        case 'coqui':
          audioBuffer = await this.synthesizeCoqui(text, opts);
          break;

        case 'system':
          audioBuffer = await this.synthesizeSystem(text, opts);
          break;

        default:
          throw new Error(`Unknown TTS provider '${provider}'. Supported: 'openai', 'system'.`);
      }

      // Save to file
      const filename = `speak-${randomUUID()}.${opts.format || 'wav'}`;
      const filepath = join(this.tempDir, filename);
      await writeFile(filepath, audioBuffer);

      return {
        success: true,
        data: { audioPath: filepath, sizeBytes: audioBuffer.length, provider },
        summary: `Synthesized ${text.length} chars → ${filepath} (${audioBuffer.length} bytes)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Speech synthesis failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  private async synthesizeOpenAI(text: string, opts: SynthOpts): Promise<Buffer> {
    const cfg = this.config.ttsConfig || {};
    const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI TTS requires OPENAI_API_KEY. Set it in your environment or voice config.');

    const baseUrl = cfg.baseUrl || 'https://api.openai.com/v1';
    const model = cfg.model || 'tts-1';
    const voice = opts.voice || cfg.voice || 'alloy';
    const format = opts.format || 'mp3';
    const speed = opts.speed || 1.0;

    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: text, voice, response_format: format, speed }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI TTS failed (HTTP ${res.status}): ${body}. Check API key validity and quota.`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async synthesizeCoqui(text: string, opts: SynthOpts): Promise<Buffer> {
    const cfg = this.config.ttsConfig || {};
    const binary = cfg.binaryPath || 'tts';
    const voice = opts.voice || cfg.voice || 'tts_models/en/ljspeech/tacotron2-DDC';
    const outPath = join(this.tempDir, `tts-${randomUUID()}.wav`);

    return new Promise((resolve, reject) => {
      const args = ['--model_name', voice, '--text', text, '--out_path', outPath];
      if (opts.speed) args.push('--speed', String(opts.speed));

      execFile(binary, args, async (err) => {
        if (err) { reject(new Error(`Coqui TTS failed: ${err.message}`)); return; }
        try { resolve(await readFile(outPath)); }
        catch (e) { reject(new Error(`Failed to read TTS output: ${e}`)); }
      });
    });
  }

  private async synthesizeSystem(text: string, opts: SynthOpts): Promise<Buffer> {
    const cfg = this.config.ttsConfig || {};
    const outPath = join(this.tempDir, `tts-${randomUUID()}.wav`);
    const isMac = process.platform === 'darwin';
    const command = cfg.systemCommand || (isMac ? 'say' : 'espeak');

    return new Promise((resolve, reject) => {
      const args: string[] = [];
      if (isMac) {
        if (opts.voice) args.push('-v', opts.voice);
        if (opts.speed) args.push('-r', String(Math.round(opts.speed * 175)));
        args.push('-o', outPath, text);
      } else {
        args.push('-w', outPath);
        if (opts.voice) args.push('-v', opts.voice);
        if (opts.speed) args.push('-s', String(Math.round(opts.speed * 175)));
        args.push(text);
      }

      execFile(command, args, async (err) => {
        if (err) { reject(new Error(`System TTS failed: ${err.message}`)); return; }
        try { resolve(await readFile(outPath)); }
        catch (e) { reject(new Error(`Failed to read TTS output: ${e}`)); }
      });
    });
  }
}