/**
 * Lodestone — Built-in Tool Registration
 *
 * Shared function to register all 39 built-in tools on an engine instance.
 * Used by both `packages/core/src/main.ts` (Docker/headless) and
 * `packages/cli/src/commands/start.ts` (CLI) so both paths get the same tools.
 */

import type { LodestoneEngine } from '../engine.js';
import { resolve } from 'path';

import { WikiResolveTool, WikiSearchTool } from './impl/wiki-resolve.js';
import { WikiWriteTool } from './impl/wiki-write.js';
import { WikiReadTool } from './impl/wiki-read.js';
import { MemoryStoreTool } from './impl/memory-store.js';
import { MemoryRecallTool } from './impl/memory-recall.js';
import { SmartRetrieveTool } from './impl/smart-retrieve.js';
import { DecisionLogTool } from './impl/decision-log.js';
import { ResumeStateTool } from './impl/resume-state.js';
import { WatchdogTool } from './impl/watchdog.js';
import { BusinessHoursTool } from './impl/business-hours.js';
import { WebSearchTool } from './impl/web-search.js';
import { WebFetchTool } from './impl/web-fetch.js';
import { FileOpsTool } from './impl/file-ops.js';
import { CodeExecTool } from './impl/code-exec.js';
import { CalendarTool } from './impl/calendar.js';
import { VisionTool } from './impl/vision.js';
import { VoiceTool } from './impl/voice.js';
import { CoordinatorTool } from './impl/coordinator.js';
import { ShellExecTool } from './impl/shell.js';
import { HttpRequestTool } from './impl/http.js';
import { ProcessManagerTool } from './impl/process-manager.js';
import { DiffPatchTool } from './impl/diff-patch.js';
import { GitTool } from './impl/git.js';
import { BrowserTool } from './impl/browser.js';
import { SchedulerTool } from './impl/scheduler.js';
import { SendMessageTool } from './impl/send-message.js';
import { DatabaseTool } from './impl/database.js';
import { McpClientTool } from './impl/mcp-client.js';
import { ImageGenTool } from './impl/image-gen.js';
import { OcrTool } from './impl/ocr.js';
import { TranscribeTool } from './impl/transcribe.js';
import { ClipboardTool } from './impl/clipboard.js';
import { NotifyTool } from './impl/notify.js';
import { SecretsTool } from './impl/secrets.js';
import { SearchEngineTool } from './impl/search-engine.js';
import { ScreenshotTool } from './impl/screenshot.js';
import { ArchiveTool } from './impl/zip.js';
import { LspTool } from './impl/lsp.js';

/**
 * Register all 39 built-in tools on the given engine.
 *
 * @param engine - The LodestoneEngine instance to register tools onto.
 * @param workspaceRoot - Absolute path to the workspace root (used for
 *   decision-log DB path and file-ops sandbox).
 */
export function registerBuiltinTools(engine: LodestoneEngine, workspaceRoot: string): void {
  engine.registerTool(new WikiResolveTool());
  engine.registerTool(new WikiSearchTool());
  engine.registerTool(new WikiWriteTool());
  engine.registerTool(new WikiReadTool());
  engine.registerTool(new MemoryStoreTool());
  engine.registerTool(new MemoryRecallTool());
  engine.registerTool(new SmartRetrieveTool());
  engine.registerTool(new DecisionLogTool(resolve(workspaceRoot, 'data/decisions.json')));
  engine.registerTool(new ResumeStateTool());
  engine.registerTool(new WatchdogTool());
  engine.registerTool(new BusinessHoursTool());
  engine.registerTool(new WebSearchTool({ provider: 'searxng', searxngUrl: 'http://localhost:8888' }));
  engine.registerTool(new WebFetchTool());
  engine.registerTool(new FileOpsTool({ workspaceRoot: resolve(workspaceRoot) }));
  engine.registerTool(new CodeExecTool());
  engine.registerTool(new CalendarTool({ provider: 'caldav' }));
  engine.registerTool(new VisionTool());
  engine.registerTool(new VoiceTool());
  engine.registerTool(new CoordinatorTool());
  engine.registerTool(new ShellExecTool({ workspaceRoot: resolve(workspaceRoot) }));
  engine.registerTool(new HttpRequestTool());
  engine.registerTool(new ProcessManagerTool());
  engine.registerTool(new DiffPatchTool({ workspaceRoot: resolve(workspaceRoot) }));
  engine.registerTool(new GitTool({ defaultRepo: resolve(workspaceRoot) }));
  engine.registerTool(new BrowserTool());
  engine.registerTool(new SchedulerTool());
  engine.registerTool(new SendMessageTool());
  engine.registerTool(new DatabaseTool());
  engine.registerTool(new McpClientTool());
  engine.registerTool(new ImageGenTool());
  engine.registerTool(new OcrTool());
  engine.registerTool(new TranscribeTool());
  engine.registerTool(new ClipboardTool());
  engine.registerTool(new NotifyTool());
  engine.registerTool(new SecretsTool());
  engine.registerTool(new SearchEngineTool());
  engine.registerTool(new ScreenshotTool());
  engine.registerTool(new ArchiveTool());
  engine.registerTool(new LspTool());
}