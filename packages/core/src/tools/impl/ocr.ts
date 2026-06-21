/**
 * Lodestone Tool — OCR (Optical Character Recognition)
 *
 * Extracts text from images and PDFs.
 * Uses Tesseract.js for images, pdf-parse for PDFs, with fallback to Tesseract for scanned PDFs.
 * Supports local files and remote URLs.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { readFile, writeFile, mkdtempSync, rmSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

export class OcrTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'ocr',
    name: 'OCR / Text Extraction',
    description: 'Extract text from images and PDFs. Supports Tesseract.js for images and pdf-parse for PDFs. Can fetch files from URLs.',
    parameters: [
      { name: 'path', type: 'string', description: 'File path relative to workspace or absolute URL', required: true },
      { name: 'format', type: 'string', description: 'Output format: text or structured', required: false, enum: ['text', 'structured'], default: 'text' },
      { name: 'lang', type: 'string', description: 'Language hint for OCR (default: eng)', required: false, default: 'eng' },
    ],
    sideEffects: false,
    requiresApproval: false,
    timeout: 30000,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const inputPath = params.path as string;
    const format = (params.format as string) || 'text';
    const lang = (params.lang as string) || 'eng';
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

    try {
      // Determine if it's a URL or a file path
      const isUrl = inputPath.startsWith('http://') || inputPath.startsWith('https://');
      let localPath: string;
      let cleanupTemp: string | null = null;

      if (isUrl) {
        // Download the file to a temp location
        const tempDir = mkdtempSync(join(tmpdir(), 'lodestone-ocr-'));
        cleanupTemp = tempDir;
        const ext = this.guessExtension(inputPath);
        localPath = join(tempDir, `input${ext}`);
        await this.downloadFile(inputPath, localPath);
      } else {
        // Resolve relative to workspace
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

      // Determine file type
      const ext = localPath.toLowerCase().split('.').pop() || '';
      let result: { text: string; confidence: number; pages: number; lang: string };

      if (ext === 'pdf') {
        result = await this.processPdf(localPath, lang);
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'].includes(ext)) {
        result = await this.processImage(localPath, lang);
      } else {
        // Try to process as image anyway
        result = await this.processImage(localPath, lang);
      }

      if (cleanupTemp) this.cleanup(cleanupTemp);

      const data = format === 'structured'
        ? result
        : { text: result.text, lang: result.lang };

      return {
        success: true,
        data,
        summary: `Extracted ${result.text.length} chars from ${inputPath} (${result.pages} page(s), confidence: ${result.confidence})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `OCR failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── Image Processing (Tesseract) ───────────────────────────────────────────

  private async processImage(imagePath: string, lang: string): Promise<{ text: string; confidence: number; pages: number; lang: string }> {
    // Try using system tesseract first (faster, no npm dependency)
    try {
      const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', lang], { timeout: 25000 });
      return {
        text: stdout.trim(),
        confidence: 0.9, // System tesseract doesn't expose confidence easily
        pages: 1,
        lang,
      };
    } catch {
      // Fall back to tesseract.js (lazy dynamic import)
      try {
        // @ts-expect-error - tesseract.js is an optional dependency
        const tesseract = await import("tesseract.js");
        const worker = await tesseract.createWorker(lang);
        const result = await worker.recognize(imagePath);
        await worker.terminate();
        return {
          text: result.data.text.trim(),
          confidence: result.data.confidence / 100,
          pages: 1,
          lang,
        };
      } catch {
        throw new Error(
          'OCR requires either system tesseract or the tesseract.js package. ' +
          'Install tesseract.js: npm install tesseract.js. ' +
          'Or install system tesseract: brew install tesseract (macOS) / apt install tesseract-ocr (Linux)'
        );
      }
    }
  }

  // ─── PDF Processing ─────────────────────────────────────────────────────────

  private async processPdf(pdfPath: string, lang: string): Promise<{ text: string; confidence: number; pages: number; lang: string }> {
    // Try pdf-parse first (extracts embedded text)
    try {
      // @ts-expect-error - pdf-parse is an optional dependency
      const pdfParse = await import('pdf-parse');
      const buffer = await readFileAsync(pdfPath);
      const data = await pdfParse.default(buffer);
      const text = data.text.trim();

      // If we got meaningful text, the PDF is text-based
      if (text.length > 50) {
        return {
          text,
          confidence: 0.95,
          pages: data.numpages,
          lang,
        };
      }

      // Otherwise, it's likely a scanned PDF — fall through to OCR
    } catch {
      // pdf-parse not available or failed — continue to OCR approach
    }

    // For scanned PDFs, convert pages to images and OCR each
    // Try using pdftoppm (poppler) to convert pages to images
    const tempDir = mkdtempSync(join(tmpdir(), 'lodestone-pdf-ocr-'));
    try {
      await execFileAsync('pdftoppm', [pdfPath, join(tempDir, 'page'), '-png', '-r', '200'], { timeout: 25000 });

      // Find generated page images
      const { readdir } = await import('fs/promises');
      const files = (await readdir(tempDir)).filter(f => f.endsWith('.png')).sort();
      const pages: string[] = [];

      for (const file of files) {
        const imgPath = join(tempDir, file);
        const pageResult = await this.processImage(imgPath, lang);
        pages.push(pageResult.text);
      }

      if (pages.length === 0) {
        throw new Error('Could not extract text from PDF. For scanned PDFs, install poppler: brew install poppler (macOS) / apt install poppler-utils (Linux)');
      }

      return {
        text: pages.join('\n\n--- Page Break ---\n\n'),
        confidence: 0.8,
        pages: pages.length,
        lang,
      };
    } catch (err) {
      // If pdftoppm isn't available, try with pdf-parse if we haven't already
      try {
        // @ts-expect-error - pdf-parse is an optional dependency
        const pdfParse = await import('pdf-parse');
        const buffer = await readFileAsync(pdfPath);
        const data = await pdfParse.default(buffer);
        if (data.text.trim().length > 0) {
          return {
            text: data.text.trim(),
            confidence: 0.7,
            pages: data.numpages,
            lang,
          };
        }
      } catch {
        // Both approaches failed
      }
      throw new Error(
        `Could not extract text from PDF: ${err}. ` +
        'For scanned PDFs, install poppler (pdftoppm) and tesseract: ' +
        'brew install poppler tesseract (macOS) / apt install poppler-utils tesseract-ocr (Linux)'
      );
    } finally {
      this.cleanup(tempDir);
    }
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
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'pdf'].includes(ext)) {
      return `.${ext}`;
    }
    return '.png'; // Default
  }

  private cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}