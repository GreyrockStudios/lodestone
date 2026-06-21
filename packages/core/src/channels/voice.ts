/**
 * Lodestone Core — Voice Channel
 *
 * Voice-first channel: transcribes audio input via Whisper (API or local),
 * synthesises speech via multiple TTS backends (OpenAI, Coqui/Piper, system),
 * and integrates with the agent loop for full voice conversations.
 *
 * No external dependencies — uses built-in fetch for API calls and
 * child_process for system TTS (say/espeak).
 */

import { Channel, type ChannelConfig, type ChannelMessage } from './channel.js';
import { Logger } from '../utils/logger.js';
import { execFile } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SynthOpts {
  /** Voice name (provider-specific) */
  voice?: string;
  /** Speech speed multiplier (0.5–4.0, default 1.0) */
  speed?: number;
  /** Output audio format */
  format?: 'mp3' | 'wav' | 'opus';
}

export interface VoiceMessage {
  id: string;
  from: string;
  audioPath: string;
  duration: number;
  transcribedText?: string;
}

export interface VoiceChannelConfig extends ChannelConfig {
  type: 'voice';
  /** Speech-to-text provider */
  sttProvider: 'whisper-api' | 'whisper-local' | 'system';
  /** STT configuration */
  sttConfig?: {
    /** OpenAI API key (for whisper-api) */
    apiKey?: string;
    /** OpenAI base URL (for self-hosted Whisper API) */
    baseUrl?: string;
    /** Model name (e.g., 'whisper-1') */
    model?: string;
    /** Path to local whisper binary (for whisper-local) */
    binaryPath?: string;
  };
  /** Text-to-speech provider */
  ttsProvider: 'openai' | 'coqui' | 'system';
  /** TTS configuration */
  ttsConfig?: {
    /** OpenAI API key (for openai TTS) */
    apiKey?: string;
    /** OpenAI base URL */
    baseUrl?: string;
    /** Model name (e.g., 'tts-1') */
    model?: string;
    /** Default voice */
    voice?: string;
    /** Path to Coqui/Piper binary */
    binaryPath?: string;
    /** System TTS command ('say' on macOS, 'espeak' on Linux) */
    systemCommand?: string;
  };
  /** Directory for temporary audio files */
  tempDir?: string;
}

// ─── Channel Health ──────────────────────────────────────────────────────────

export interface VoiceHealthDetails {
  ok: boolean;
  sttProvider: string;
  ttsProvider: string;
  error?: string;
}

// ─── Voice Channel ──────────────────────────────────────────────────────────

export class VoiceChannel extends Channel {
  private logger: Logger;
  private readonly voiceConfig: VoiceChannelConfig;
  private readonly tempDir: string;

  constructor(config: VoiceChannelConfig) {
    super(config);
    this.voiceConfig = config;
    this.logger = new Logger({ minLevel: 'info' });
    this.tempDir = config.tempDir || join(process.cwd(), 'data/voice');
  }

  get id(): string {
    return `voice:${this.voiceConfig.sttProvider}-${this.voiceConfig.ttsProvider}`;
  }

  get name(): string {
    return 'Voice';
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Ensure temp directory exists
    if (!existsSync(this.tempDir)) {
      await mkdir(this.tempDir, { recursive: true });
    }

    // Validate STT provider
    if (this.voiceConfig.sttProvider === 'whisper-api' && !this.voiceConfig.sttConfig?.apiKey) {
      this.logger.warn('[Channel:Voice] whisper-api configured without API key — transcription will fail');
    }

    // Validate TTS provider
    if (this.voiceConfig.ttsProvider === 'openai' && !this.voiceConfig.ttsConfig?.apiKey) {
      this.logger.warn('[Channel:Voice] openai TTS configured without API key — synthesis will fail');
    }

    this.running = true;
    this.logger.info(`[Channel:Voice] Started — STT: ${this.voiceConfig.sttProvider}, TTS: ${this.voiceConfig.ttsProvider}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.info('[Channel:Voice] Stopped');
  }

  protected async sendRaw(sessionId: string, message: string): Promise<void> {
    // Synthesize text to speech and "send" as audio
    try {
      const audioBuffer = await this.synthesize(message);
      const filename = `${sessionId}-${Date.now()}.wav`;
      const filepath = join(this.tempDir, filename);
      await writeFile(filepath, audioBuffer);
      this.logger.info(`[Channel:Voice] Synthesized ${message.length} chars → ${filename}`);
    } catch (err) {
      this.logger.error('[Channel:Voice] Send/synthesize failed:', { error: String(err) });
    }
  }

  getMaxMessageLength(): number {
    return 0; // No hard limit for voice
  }

  // ─── Transcription ───────────────────────────────────────────────────────

  /**
   * Transcribe audio file to text using configured STT provider.
   */
  async transcribe(audioPath: string): Promise<string> {
    const start = Date.now();

    try {
      const audioBuffer = await readFile(audioPath);

      switch (this.voiceConfig.sttProvider) {
        case 'whisper-api':
          return await this.transcribeWhisperAPI(audioBuffer, audioPath);

        case 'whisper-local':
          return await this.transcribeWhisperLocal(audioPath);

        case 'system':
          // System STT is not widely available — fall back to whisper-local
          this.logger.warn('[Channel:Voice] System STT not available, falling back to whisper-local');
          return await this.transcribeWhisperLocal(audioPath);

        default:
          throw new Error(`Unknown STT provider '${this.voiceConfig.sttProvider}'. Supported: 'openai', 'whisper-local', 'system'.`);
      }
    } catch (err) {
      this.logger.error('[Channel:Voice] Transcription failed', { error: String(err), audioPath });
      throw err;
    } finally {
      this.logger.debug(`[Channel:Voice] Transcribe took ${Date.now() - start}ms`);
    }
  }

  private async transcribeWhisperAPI(audioBuffer: Buffer, audioPath: string): Promise<string> {
    const cfg = this.voiceConfig.sttConfig || {};
    const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Whisper API STT requires OPENAI_API_KEY. Set it in your environment or voice channel config.');

    const baseUrl = cfg.baseUrl || 'https://api.openai.com/v1';
    const model = cfg.model || 'whisper-1';

    // Determine content type from file extension
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
      throw new Error(`Whisper API STT failed (HTTP ${res.status}): ${body}. Check API key validity and quota.`);
    }

    const data = await res.json() as { text: string };
    return data.text.trim();
  }

  private async transcribeWhisperLocal(audioPath: string): Promise<string> {
    const binary = this.voiceConfig.sttConfig?.binaryPath || 'whisper';

    return new Promise((resolve, reject) => {
      execFile(binary, [audioPath, '--output_format', 'txt', '--output_dir', this.tempDir], (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Local whisper failed: ${err.message}`));
          return;
        }

        // Whisper writes output as <basename>.txt
        const baseName = audioPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'audio';
        const txtPath = join(this.tempDir, `${baseName}.txt`);

        readFile(txtPath, 'utf-8')
          .then(text => resolve(text.trim()))
          .catch(() => resolve(stdout.trim())); // Fall back to stdout
      });
    });
  }

  // ─── Synthesis ────────────────────────────────────────────────────────────

  /**
   * Synthesize text to speech, returning an audio Buffer.
   */
  async synthesize(text: string, opts?: SynthOpts): Promise<Buffer> {
    const start = Date.now();

    try {
      let buffer: Buffer;

      switch (this.voiceConfig.ttsProvider) {
        case 'openai':
          buffer = await this.synthesizeOpenAI(text, opts);
          break;

        case 'coqui':
          buffer = await this.synthesizeCoqui(text, opts);
          break;

        case 'system':
          buffer = await this.synthesizeSystem(text, opts);
          break;

        default:
          throw new Error(`Unknown TTS provider '${this.voiceConfig.ttsProvider}'. Supported: 'openai', 'system'.`);
      }

      this.logger.debug(`[Channel:Voice] Synthesize took ${Date.now() - start}ms`);
      return buffer;
    } catch (err) {
      this.logger.error('[Channel:Voice] Synthesis failed', { error: String(err) });
      throw err;
    }
  }

  private async synthesizeOpenAI(text: string, opts?: SynthOpts): Promise<Buffer> {
    const cfg = this.voiceConfig.ttsConfig || {};
    const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI TTS requires OPENAI_API_KEY. Set it in your environment or voice channel config.');

    const baseUrl = cfg.baseUrl || 'https://api.openai.com/v1';
    const model = cfg.model || 'tts-1';
    const voice = opts?.voice || cfg.voice || 'alloy';
    const format = opts?.format || 'mp3';
    const speed = opts?.speed || 1.0;

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

  private async synthesizeCoqui(text: string, opts?: SynthOpts): Promise<Buffer> {
    const cfg = this.voiceConfig.ttsConfig || {};
    const binary = cfg.binaryPath || 'tts';
    const voice = opts?.voice || cfg.voice || 'tts_models/en/ljspeech/tacotron2-DDC';
    const outPath = join(this.tempDir, `tts-${randomUUID()}.wav`);

    return new Promise((resolve, reject) => {
      const args = [
        '--model_name', voice,
        '--text', text,
        '--out_path', outPath,
      ];

      if (opts?.speed) args.push('--speed', String(opts.speed));

      execFile(binary, args, async (err) => {
        if (err) {
          reject(new Error(`Coqui TTS failed: ${err.message}`));
          return;
        }
        try {
          const buffer = await readFile(outPath);
          resolve(buffer);
        } catch (readErr) {
          reject(new Error(`Failed to read TTS output: ${readErr}`));
        }
      });
    });
  }

  private async synthesizeSystem(text: string, opts?: SynthOpts): Promise<Buffer> {
    const cfg = this.voiceConfig.ttsConfig || {};
    const outPath = join(this.tempDir, `tts-${randomUUID()}.wav`);

    // Detect platform: macOS uses 'say', Linux uses 'espeak'
    const isMac = process.platform === 'darwin';
    const command = cfg.systemCommand || (isMac ? 'say' : 'espeak');

    return new Promise((resolve, reject) => {
      const args: string[] = [];

      if (isMac) {
        // macOS 'say' command
        if (opts?.voice) args.push('-v', opts.voice);
        if (opts?.speed) args.push('-r', String(Math.round(opts.speed * 175))); // words per minute
        args.push('-o', outPath, text);
      } else {
        // espeak on Linux
        args.push('-w', outPath);
        if (opts?.voice) args.push('-v', opts.voice);
        if (opts?.speed) args.push('-s', String(Math.round((opts.speed || 1) * 175)));
        args.push(text);
      }

      execFile(command, args, async (err) => {
        if (err) {
          reject(new Error(`System TTS failed: ${err.message}`));
          return;
        }
        try {
          const buffer = await readFile(outPath);
          resolve(buffer);
        } catch (readErr) {
          reject(new Error(`Failed to read TTS output: ${readErr}`));
        }
      });
    });
  }

  // ─── Full Voice Pipeline ───────────────────────────────────────────────────

  /**
   * Handle a voice message: transcribe → emit to handler → synthesize response.
   * Returns the transcribed text.
   */
  async handleVoiceMessage(audioPath: string, from: string): Promise<string> {
    const start = Date.now();

    // 1. Transcribe audio
    const transcribedText = await this.transcribe(audioPath);
    this.logger.info(`[Channel:Voice] Transcribed ${audioPath.length} chars from ${from}`, {
      textLength: transcribedText.length,
    });

    // 2. Build ChannelMessage and emit to handler
    const sessionId = `voice-${from}`;
    const message: ChannelMessage = {
      sessionId,
      content: transcribedText,
      senderId: from,
      senderName: from,
      channelId: this.id,
      timestamp: new Date().toISOString(),
      metadata: {
        audioPath,
        voiceMessage: true,
      },
    };

    await this.emitMessage(message);

    this.logger.debug(`[Channel:Voice] handleVoiceMessage took ${Date.now() - start}ms`);
    return transcribedText;
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  getHealth(): import('./channel.js').ChannelHealth {
    const details: Record<string, unknown> = {
      ok: this.running,
      sttProvider: this.voiceConfig.sttProvider,
      ttsProvider: this.voiceConfig.ttsProvider,
    };

    // Check for missing configuration
    if (this.voiceConfig.sttProvider === 'whisper-api' && !this.voiceConfig.sttConfig?.apiKey) {
      details.ok = false;
      details.error = 'whisper-api missing API key';
    }
    if (this.voiceConfig.ttsProvider === 'openai' && !this.voiceConfig.ttsConfig?.apiKey) {
      details.ok = false;
      details.error = 'openai TTS missing API key';
    }

    return {
      status: details.ok ? 'healthy' : 'degraded',
      active: this.running,
      messagesSent: this.messagesSent,
      messagesFailed: this.messagesFailed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
      details,
    };
  }
}