/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Browser
 *
 * Headless browser control via Playwright.
 * Supports navigation, screenshots, clicking, typing, extraction, and JS evaluation.
 * Uses a static page reference so state persists across calls within a session.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

interface BrowserPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status: number }>;
  title(): Promise<string>;
  screenshot(opts: Record<string, unknown>): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  $(selector: string): { textContent(): Promise<string | null> } | null;
  evaluate<T>(fn: string): Promise<T>;
  setViewportSize?(opts: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
}

interface BrowserState {
  browser: { close(): Promise<void> } | null;
  page: BrowserPage | null;
}

export class BrowserTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'browser',
    name: 'Browser',
    description: 'Headless browser control via Playwright. Navigate, screenshot, click, type, extract, and evaluate JS.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: navigate, screenshot, click, type, extract, evaluate, close', required: true, enum: ['navigate', 'screenshot', 'click', 'type', 'extract', 'evaluate', 'close'] },
      { name: 'url', type: 'string', description: 'URL to navigate to (for navigate action)', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector (for click, type, extract, or screenshot target)', required: false },
      { name: 'text', type: 'string', description: 'Text to type (for type action)', required: false },
      { name: 'script', type: 'string', description: 'JS to evaluate in page context (for evaluate action)', required: false },
      { name: 'width', type: 'number', description: 'Viewport width (default: 1280)', required: false, default: 1280 },
      { name: 'height', type: 'number', description: 'Viewport height (default: 720)', required: false, default: 720 },
      { name: 'format', type: 'string', description: 'Screenshot format: png or jpeg (default: png)', required: false, enum: ['png', 'jpeg'] },
      { name: 'fullPage', type: 'boolean', description: 'Capture full page screenshot (default: false)', required: false, default: false },
      { name: 'saveTo', type: 'string', description: 'File path to save screenshot (optional, returns base64 if not provided)', required: false },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 30000,
  };

  private static state: BrowserState = { browser: null, page: null };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const start = Date.now();

    try {
      switch (action) {
        case 'navigate':
          return await this.navigate(params, start);
        case 'screenshot':
          return await this.screenshot(params, start);
        case 'click':
          return await this.click(params, start);
        case 'type':
          return await this.type(params, start);
        case 'extract':
          return await this.extract(params, start);
        case 'evaluate':
          return await this.evaluate(params, start);
        case 'close':
          return await this.close(start);
        default:
          return {
            success: false, data: null,
            summary: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`,
            durationMs: Date.now() - start, includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false, data: null,
        summary: `Browser action "${action}" failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
  }

  private async ensureBrowser(width: number, height: number): Promise<BrowserState['page']> {
    if (BrowserTool.state.page && BrowserTool.state.browser) {
      return BrowserTool.state.page;
    }

    let playwright: { chromium: { launch(opts?: Record<string, unknown>): Promise<BrowserState['browser'] & { newPage(): Promise<BrowserPage> }> } };
    try {
      // @ts-ignore — playwright may not be installed
      playwright = await import('playwright');
    } catch {
      throw new Error('Playwright is not installed. Install it with: npm install playwright and npx playwright install chromium. See https://playwright.dev for setup.');
    }

    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    if (page.setViewportSize) {
      await page.setViewportSize({ width, height });
    }

    BrowserTool.state = { browser, page };
    return page;
  }

  private async navigate(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const url = params.url as string;
    if (!url) return this.missingParam('url', start);

    const width = (params.width as number) || 1280;
    const height = (params.height as number) || 720;
    const page = await this.ensureBrowser(width, height);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();

    return {
      success: true,
      data: { url, title, status: response?.status ?? 0 },
      summary: `Navigated to ${url} (${title})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async screenshot(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const width = (params.width as number) || 1280;
    const height = (params.height as number) || 720;
    const format = (params.format as string) || 'png';
    const fullPage = (params.fullPage as boolean) ?? false;
    const selector = params.selector as string | undefined;
    const saveTo = params.saveTo as string | undefined;

    const page = await this.ensureBrowser(width, height);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');

    // If a selector is provided, screenshot just that element
    // Otherwise take a full page or viewport screenshot
    const screenshotOpts: Record<string, unknown> = {
      type: format === 'jpeg' ? 'jpeg' : 'png',
      fullPage,
    };

    // If selector is provided, we need to clip to that element
    // Playwright's element screenshot isn't available in our minimal interface,
    // so we use evaluate to get the bounding box and pass clip option
    if (selector) {
      const bbox = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`);
      if (!bbox) {
        return {
          success: false, data: null,
          summary: `Element not found for screenshot: ${selector}`,
          error: `No element matches "${selector}"`,
          durationMs: Date.now() - start, includeInContext: false,
        };
      }
      screenshotOpts.clip = bbox;
      screenshotOpts.fullPage = false;
    }

    const buffer = await page.screenshot(screenshotOpts);
    const base64 = buffer.toString('base64');

    // If saveTo is provided, write to file
    if (saveTo) {
      const { writeFile } = await import('fs/promises');
      await writeFile(saveTo, buffer);
      return {
        success: true,
        data: { path: saveTo, width, height, format, fullPage, selector: selector || null },
        summary: `Screenshot saved to ${saveTo} (${width}x${height}${fullPage ? ' fullPage' : ''}${selector ? ` selector: ${selector}` : ''})`,
        durationMs: Date.now() - start,
        includeInContext: true,
      };
    }

    return {
      success: true,
      data: { screenshot: `data:image/${format};base64,${base64}`, width, height, format, fullPage, selector: selector || null },
      summary: `Screenshot taken (${width}x${height}${fullPage ? ' fullPage' : ''}${selector ? ` selector: ${selector}` : ''})`,
      durationMs: Date.now() - start,
      includeInContext: false, // Don't inject base64 into LLM context
    };
  }

  private async click(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const selector = params.selector as string;
    if (!selector) return this.missingParam('selector', start);

    const page = await this.ensureBrowser(1280, 720);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');
    await page.click(selector);

    return {
      success: true,
      data: { selector, clicked: true },
      summary: `Clicked "${selector}"`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async type(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const selector = params.selector as string;
    const text = params.text as string;
    if (!selector) return this.missingParam('selector', start);
    if (!text) return this.missingParam('text', start);

    const page = await this.ensureBrowser(1280, 720);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');
    await page.fill(selector, text);

    return {
      success: true,
      data: { selector, typed: text.length },
      summary: `Typed ${text.length} chars into "${selector}"`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async extract(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const selector = params.selector as string | undefined;
    const page = await this.ensureBrowser(1280, 720);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');

    let text: string;
    if (selector) {
      const el = page.$(selector);
      if (!el) {
        return {
          success: false, data: null,
          summary: `Element not found: ${selector}`,
          error: `No element matches "${selector}"`,
          durationMs: Date.now() - start, includeInContext: false,
        };
      }
      text = (await el.textContent()) || '';
    } else {
      // Extract full page text
      text = await page.evaluate<string>('document.body.innerText');
    }

    return {
      success: true,
      data: { selector: selector || 'body', text, length: text.length },
      summary: `Extracted ${text.length} chars from ${selector || 'full page'}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async evaluate(params: Record<string, unknown>, start: number): Promise<ToolResult> {
    const script = params.script as string;
    if (!script) return this.missingParam('script', start);

    const page = await this.ensureBrowser(1280, 720);
    if (!page) throw new Error('Failed to initialize browser page. Ensure Playwright is installed and no other browser instance is locking the profile.');
    const result = await page.evaluate(script);

    return {
      success: true,
      data: { result },
      summary: `Evaluated JS, result: ${JSON.stringify(result).slice(0, 200)}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async close(start: number): Promise<ToolResult> {
    if (BrowserTool.state.browser) {
      await BrowserTool.state.browser.close();
    }
    BrowserTool.state = { browser: null, page: null };

    return {
      success: true,
      data: { closed: true },
      summary: 'Browser closed',
      durationMs: Date.now() - start,
      includeInContext: false,
    };
  }

  private missingParam(name: string, start: number): ToolResult {
    return {
      success: false, data: null,
      summary: `Missing required parameter: ${name}`,
      error: `Missing parameter: ${name}`,
      durationMs: Date.now() - start, includeInContext: false,
    };
  }
}