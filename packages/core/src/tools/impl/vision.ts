/**
 * Lodestone Tool — Vision / Multimodal
 *
 * Image understanding via vision models (OpenAI gpt-4o, Ollama with LLaVA)
 * and OCR via Tesseract or vision models.
 * Tools: analyze_image, extract_text, describe_image, screenshot_url, compare_images.
 *
 * No external dependencies — uses built-in fetch for API calls,
 * child_process for Tesseract.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { Logger } from '../../utils/logger.js';
import { execFile } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImageAnalysis {
  description: string;
  textExtracted?: string;
  objects: string[];
  confidence: number;
}

export interface ComparisonResult {
  similarity: number;
  differences: string[];
}

export interface VisionToolConfig {
  /** Vision provider */
  provider?: 'openai' | 'ollama' | 'tesseract';
  /** Model name (e.g., 'gpt-4o', 'llava:13b') */
  model?: string;
  /** Path to tesseract binary (for tesseract provider) */
  tesseractPath?: string;
  /** OpenAI API key (for openai provider) */
  apiKey?: string;
  /** OpenAI base URL */
  baseUrl?: string;
  /** Ollama base URL (for ollama provider) */
  ollamaUrl?: string;
}

// ─── Vision Tool ─────────────────────────────────────────────────────────────

export class VisionTool implements Tool {
  readonly definition: ToolDefinition;
  private logger: Logger;
  private config: VisionToolConfig;
  private tempDir: string;

  constructor(config?: VisionToolConfig) {
    this.config = config || {};
    this.logger = new Logger({ minLevel: 'info' });
    this.tempDir = join(process.cwd(), 'data/vision');

    this.definition = {
      id: 'vision',
      name: 'Vision / Multimodal',
      description: 'Analyze images, extract text (OCR), describe contents, compare images, and take screenshots. Actions: analyze_image, extract_text, describe_image, screenshot_url, compare_images.',
      parameters: [
        {
          name: 'action',
          description: 'analyze_image, extract_text, describe_image, screenshot_url, or compare_images',
          type: 'string',
          required: true,
          enum: ['analyze_image', 'extract_text', 'describe_image', 'screenshot_url', 'compare_images'],
        },
        {
          name: 'imagePath',
          description: 'Path to the image file to analyze/describe/extract',
          type: 'string',
          required: false,
        },
        {
          name: 'question',
          description: 'Question to ask about the image (for analyze_image)',
          type: 'string',
          required: false,
        },
        {
          name: 'url',
          description: 'URL to screenshot (for screenshot_url)',
          type: 'string',
          required: false,
        },
        {
          name: 'imagePath2',
          description: 'Second image path (for compare_images)',
          type: 'string',
          required: false,
        },
      ],
      sideEffects: false,
      requiresApproval: false,
      timeout: 30000,
    };
  }

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      if (!existsSync(this.tempDir)) {
        await mkdir(this.tempDir, { recursive: true });
      }

      switch (action) {
        case 'analyze_image':
          return await this.analyzeImage(
            params.imagePath as string,
            params.question as string,
          );

        case 'extract_text':
          return await this.extractText(params.imagePath as string);

        case 'describe_image':
          return await this.describeImage(params.imagePath as string);

        case 'screenshot_url':
          return await this.screenshot(params.url as string);

        case 'compare_images':
          return await this.compareImages(
            params.imagePath as string,
            params.imagePath2 as string,
          );

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown vision action: ${action}`,
            error: 'Valid actions: analyze_image, extract_text, describe_image, screenshot_url, compare_images',
            durationMs: Date.now() - start,
            includeInContext: true,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: 'Vision tool error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Analyze Image ─────────────────────────────────────────────────────────

  /**
   * Analyze an image with a question using the configured vision model.
   */
  async analyzeImage(imagePath: string, question: string): Promise<ToolResult> {
    const start = Date.now();

    if (!imagePath || !existsSync(imagePath)) {
      return {
        success: false, data: null,
        summary: `Image not found: ${imagePath}`,
        error: `File does not exist: ${imagePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    if (!question) question = 'Describe this image in detail.';

    try {
      const result = await this.callVisionModel(imagePath, question);
      const analysis: ImageAnalysis = {
        description: result,
        objects: this.extractObjects(result),
        confidence: 0.85, // Vision models don't expose confidence directly
      };

      return {
        success: true,
        data: analysis,
        summary: `Analyzed image: ${analysis.description.slice(0, 100)}...`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Image analysis failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Extract Text (OCR) ─────────────────────────────────────────────────────

  /**
   * Extract text from an image using Tesseract or vision model.
   */
  async extractText(imagePath: string): Promise<ToolResult> {
    const start = Date.now();

    if (!imagePath || !existsSync(imagePath)) {
      return {
        success: false, data: null,
        summary: `Image not found: ${imagePath}`,
        error: `File does not exist: ${imagePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    const provider = this.config.provider || 'tesseract';

    try {
      let text: string;

      if (provider === 'tesseract') {
        text = await this.extractTextTesseract(imagePath);
      } else {
        // Use vision model for OCR
        text = await this.callVisionModel(imagePath, 'Extract ALL text visible in this image. Return only the extracted text, nothing else.');
      }

      return {
        success: true,
        data: { text, imagePath, provider },
        summary: `Extracted ${text.length} chars from ${imagePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `OCR failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  private async extractTextTesseract(imagePath: string): Promise<string> {
    const binary = this.config.tesseractPath || 'tesseract';

    return new Promise((resolve, reject) => {
      execFile(binary, [imagePath, 'stdout'], (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Tesseract failed: ${err.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  // ─── Describe Image ────────────────────────────────────────────────────────

  /**
   * Generate a description of an image.
   */
  async describeImage(imagePath: string): Promise<ToolResult> {
    const start = Date.now();

    if (!imagePath || !existsSync(imagePath)) {
      return {
        success: false, data: null,
        summary: `Image not found: ${imagePath}`,
        error: `File does not exist: ${imagePath}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    try {
      const description = await this.callVisionModel(imagePath, 'Describe this image: what is shown, the setting, colors, mood, and any notable details.');

      return {
        success: true,
        data: { description, imagePath },
        summary: `Described image: ${description.slice(0, 100)}...`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Description failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Compare Images ────────────────────────────────────────────────────────

  /**
   * Compare two images and return similarity + differences.
   */
  async compareImages(path1: string, path2: string): Promise<ToolResult> {
    const start = Date.now();

    if (!path1 || !existsSync(path1)) {
      return { success: false, data: null, summary: `First image not found: ${path1}`, error: `File missing: ${path1}`, durationMs: Date.now() - start, includeInContext: true };
    }
    if (!path2 || !existsSync(path2)) {
      return { success: false, data: null, summary: `Second image not found: ${path2}`, error: `File missing: ${path2}`, durationMs: Date.now() - start, includeInContext: true };
    }

    try {
      // Use vision model to compare
      const base64_1 = await this.imageToBase64(path1);
      const base64_2 = await this.imageToBase64(path2);

      const prompt = 'Compare these two images. What is similar? What is different? Rate similarity 0-100%.';
      const result = await this.callVisionModelDual(base64_1, base64_2, prompt);

      // Parse similarity from response
      const similarityMatch = result.match(/(\d+)\s*%/);
      const similarity = similarityMatch ? parseInt(similarityMatch[1]) / 100 : 0.5;

      // Extract differences
      const differences = result
        .split(/\n|\.|;/)
        .map(s => s.trim())
        .filter(s => s.length > 10 && /differ|change|missing|added|removed|replaced|contrast/i.test(s))
        .slice(0, 10);

      const comparison: ComparisonResult = { similarity, differences };

      return {
        success: true,
        data: comparison,
        summary: `Similarity: ${(similarity * 100).toFixed(0)}%, ${differences.length} differences found`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Comparison failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Screenshot ─────────────────────────────────────────────────────────────

  /**
   * Take a screenshot of a URL using a headless browser or API.
   * Falls back to a simple HTML fetch if no screenshot service is available.
   */
  async screenshot(url: string): Promise<ToolResult> {
    const start = Date.now();

    if (!url) {
      return { success: false, data: null, summary: 'Missing url parameter', error: 'url is required for screenshot_url', durationMs: Date.now() - start, includeInContext: true };
    }

    try {
      // Try to use a screenshot API or local headless browser
      // For now, we fetch the page and save a textual snapshot
      // A real implementation would use Puppeteer/Playwright, but those aren't in deps
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Lodestone/0.1 (agent runtime)' },
        redirect: 'follow',
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : url;

      // Save the snapshot
      const filename = `screenshot-${randomUUID()}.html`;
      const filepath = join(this.tempDir, filename);
      await writeFile(filepath, html);

      return {
        success: true,
        data: {
          url,
          title,
          snapshotPath: filepath,
          contentLength: html.length,
          note: 'Full visual screenshot requires a headless browser (Puppeteer/Playwright). Saved HTML snapshot as fallback.',
        },
        summary: `Captured page "${title}" from ${url} (${html.length} bytes, HTML snapshot)`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Screenshot failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }
  }

  // ─── Vision Model Calling ────────────────────────────────────────────────────

  private async callVisionModel(imagePath: string, prompt: string): Promise<string> {
    const provider = this.config.provider || 'openai';
    const base64 = await this.imageToBase64(imagePath);

    switch (provider) {
      case 'openai':
        return await this.callOpenAIVision(base64, prompt);

      case 'ollama':
        return await this.callOllamaVision(base64, prompt);

      case 'tesseract':
        // Tesseract only does OCR, not general vision — but we can extract text
        return await this.extractTextTesseract(imagePath);

      default:
        throw new Error(`Unknown vision provider: ${provider}`);
    }
  }

  private async callVisionModelDual(base64_1: string, base64_2: string, prompt: string): Promise<string> {
    const provider = this.config.provider || 'openai';
    const mime1 = this.guessMimeType(base64_1);
    const mime2 = this.guessMimeType(base64_2);

    if (provider === 'openai') {
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OpenAI API key required for vision');

      const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
      const model = this.config.model || 'gpt-4o';

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime1};base64,${base64_1}` } },
              { type: 'image_url', image_url: { url: `data:${mime2};base64,${base64_2}` } },
            ],
          }],
          max_tokens: 1000,
        }),
      });

      if (!res.ok) throw new Error(`OpenAI Vision error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0].message.content;
    }

    // For Ollama, compare sequentially and synthesize
    const desc1 = await this.callOllamaVision(base64_1, prompt);
    const desc2 = await this.callOllamaVision(base64_2, prompt);
    return `Image 1: ${desc1}\n\nImage 2: ${desc2}\n\nComparison: ${prompt}`;
  }

  private async callOpenAIVision(base64: string, prompt: string): Promise<string> {
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key required for vision');

    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    const model = this.config.model || 'gpt-4o';
    const mimeType = this.guessMimeType(base64);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        }],
        max_tokens: 1000,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI Vision error ${res.status}: ${body}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  }

  private async callOllamaVision(base64: string, prompt: string): Promise<string> {
    const ollamaUrl = this.config.ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api';
    const model = this.config.model || 'llava:13b';

    // Ollama uses /api/chat or /api/generate with images
    const res = await fetch(`${ollamaUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [base64],
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama Vision error ${res.status}: ${body}`);
    }

    const data = await res.json() as { response?: string };
    return data.response || '';
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async imageToBase64(imagePath: string): Promise<string> {
    const buffer = await readFile(imagePath);
    return buffer.toString('base64');
  }

  private guessMimeType(base64: string): string {
    // Check base64 header for common image types
    const header = base64.slice(0, 4);
    if (header.startsWith('/9j/')) return 'image/jpeg';
    if (header.startsWith('iVBOR')) return 'image/png';
    if (header.startsWith('R0lGOD')) return 'image/gif';
    if (header.startsWith('UklGR')) return 'image/webp';
    return 'image/png'; // Default
  }

  private extractObjects(description: string): string[] {
    // Simple extraction: split on commas, filter for noun-like phrases
    const words = description.split(/[,.\n]/)
      .map(s => s.trim())
      .filter(s => s.length > 2 && s.length < 50)
      .slice(0, 20);
    return words;
  }
}