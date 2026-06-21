/**
 * Lodestone Tool — Image Generation
 *
 * Generates images via DALL-E (OpenAI), Stability AI, or local Ollama models.
 * Saves generated images to the workspace output directory.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync as existsSyncSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class ImageGenTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'image-gen',
    name: 'Image Generation',
    description: 'Generate images via DALL-E (OpenAI), Stability AI, or local Ollama models. Saves images to the workspace.',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Text description of the image to generate', required: true },
      { name: 'size', type: 'string', description: 'Image size: 256x256, 512x512, or 1024x1024', required: false, enum: ['256x256', '512x512', '1024x1024'], default: '512x512' },
      { name: 'provider', type: 'string', description: 'Image provider: openai, stability, or local', required: false, enum: ['openai', 'stability', 'local'], default: 'openai' },
      { name: 'count', type: 'number', description: 'Number of images to generate (default: 1)', required: false, default: 1 },
      { name: 'outputDir', type: 'string', description: 'Output directory relative to workspace (default: data/images)', required: false, default: 'data/images' },
    ],
    sideEffects: true,
    requiresApproval: false,
    timeout: 60000,
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const prompt = params.prompt as string;
    const size = (params.size as string) || '512x512';
    const provider = (params.provider as string) || 'openai';
    const count = (params.count as number) || 1;
    const outputDir = (params.outputDir as string) || 'data/images';
    const start = Date.now();

    if (!prompt) {
      return {
        success: false,
        data: null,
        summary: 'Missing required parameter: prompt',
        error: 'prompt is required',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    const absOutputDir = join(context.workspaceRoot, outputDir);

    try {
      if (!existsSyncSync(absOutputDir)) {
        await mkdir(absOutputDir, { recursive: true });
      }

      let paths: string[];

      switch (provider) {
        case 'openai':
          paths = await this.generateOpenAI(prompt, size, count, absOutputDir);
          break;
        case 'stability':
          paths = await this.generateStability(prompt, size, count, absOutputDir);
          break;
        case 'local':
          paths = await this.generateLocal(prompt, size, count, absOutputDir);
          break;
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown provider: ${provider}`,
            error: `Provider must be openai, stability, or local`,
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }

      return {
        success: true,
        data: { paths, provider, prompt, size, count },
        summary: `Generated ${paths.length} image(s) via ${provider}: ${prompt.slice(0, 80)}`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Image generation failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  // ─── OpenAI DALL-E ──────────────────────────────────────────────────────────

  private async generateOpenAI(prompt: string, size: string, count: number, outputDir: string): Promise<string[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Image generation with the openai provider requires OPENAI_API_KEY. Set it in your environment or config.');

    // Map size to OpenAI format
    const openaiSize = size as '256x256' | '512x512' | '1024x1024';

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-2',
        prompt,
        n: Math.min(count, 4), // OpenAI limits to 4 for dall-e-2
        size: openaiSize,
        response_format: 'b64_json',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI image generation failed (HTTP ${res.status}): ${body}. Check API key validity and quota.`);
    }

    const data = await res.json() as { data: Array<{ b64_json: string }> };
    const paths: string[] = [];

    for (let i = 0; i < data.data.length; i++) {
      const filename = `img-${randomUUID()}.png`;
      const filepath = join(outputDir, filename);
      const buffer = Buffer.from(data.data[i].b64_json, 'base64');
      await writeFile(filepath, buffer);
      paths.push(filepath);
    }

    return paths;
  }

  // ─── Stability AI ───────────────────────────────────────────────────────────

  private async generateStability(prompt: string, size: string, count: number, outputDir: string): Promise<string[]> {
    const apiKey = process.env.STABILITY_API_KEY;
    if (!apiKey) throw new Error('Image generation with the stability provider requires STABILITY_API_KEY. Set it in your environment or config.');

    const [width, height] = size.split('x').map(Number);
    const paths: string[] = [];

    // Stability AI text-to-image endpoint
    for (let i = 0; i < count; i++) {
      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('width', String(width));
      formData.append('height', String(height));
      formData.append('samples', '1');
      formData.append('steps', '30');

      const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-v1-6/text-to-image', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        body: formData,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Stability AI image generation failed (HTTP ${res.status}): ${body}. Check API key validity and credits.`);
      }

      const data = await res.json() as { artifacts: Array<{ base64: string }> };

      for (const artifact of data.artifacts) {
        const filename = `img-${randomUUID()}.png`;
        const filepath = join(outputDir, filename);
        const buffer = Buffer.from(artifact.base64, 'base64');
        await writeFile(filepath, buffer);
        paths.push(filepath);
      }
    }

    return paths;
  }

  // ─── Local (Ollama) ─────────────────────────────────────────────────────────

  private async generateLocal(prompt: string, _size: string, count: number, outputDir: string): Promise<string[]> {
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_IMAGE_MODEL || 'sd-turbo';
    const paths: string[] = [];

    for (let i = 0; i < count; i++) {
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama image generation failed (HTTP ${res.status}): ${body}. Verify the model supports image output.`);
      }

      const data = await res.json() as { images?: string[]; response?: string };

      if (data.images && data.images.length > 0) {
        const filename = `img-${randomUUID()}.png`;
        const filepath = join(outputDir, filename);
        const buffer = Buffer.from(data.images[0], 'base64');
        await writeFile(filepath, buffer);
        paths.push(filepath);
      } else {
        // If the model doesn't support image generation, try using it as text-to-image via CLI
        // Fallback: check if there's a local SD script
        try {
          const { stdout } = await execFileAsync('python3', [
            '-c',
            `from diffusers import StableDiffusionPipeline; print("available")`,
          ], { timeout: 5000 });

          if (stdout.trim() === 'available') {
            // Use diffusers to generate
            const scriptPath = join(outputDir, `_gen-${randomUUID()}.py`);
            const outputPath = join(outputDir, `img-${randomUUID()}.png`);
            await writeFile(scriptPath, `
from diffusers import StableDiffusionPipeline
import torch
pipe = StableDiffusionPipeline.from_pretrained("stabilityai/stable-diffusion-2-1-base", torch_dtype=torch.float16)
pipe = pipe.to("mps" if torch.backends.mps.is_available() else "cpu")
image = pipe("${prompt.replace(/"/g, '\\"')}").images[0]
image.save("${outputPath}")
print("done")
`);
            await execFileAsync('python3', [scriptPath], { timeout: 55000 });
            if (existsSyncSync(outputPath)) {
              paths.push(outputPath);
            }
          } else {
            throw new Error('Local image model did not return image data and no diffusers fallback is available. Try a different model or install diffusers (pip install diffusers).');
          }
        } catch {
          throw new Error('Local image generation requires either an Ollama image model (e.g. llava) or the diffusers Python package (pip install diffusers).');
        }
      }
    }

    return paths;
  }
}