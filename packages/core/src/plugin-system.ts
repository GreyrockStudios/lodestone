/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Plugin System
 *
 * Third-party extensions hook into the agent lifecycle without touching
 * core internals. Plugins register through a manifest, get validated,
 * and execute in a sandboxed context with limited, explicit access.
 *
 * Hook points:
 *   beforeTool  — before a tool executes (can modify params or block)
 *   afterTool   — after a tool executes (can modify result)
 *   beforeResponse — before a response is sent to the user (can modify)
 *   afterResponse  — after a response is sent (observation only)
 *   onMessage   — when an incoming message arrives (observation only)
 *
 * No LLM calls in the plugin path. Plugins are pure code — no model
 * invocations, no prompt construction. That stays in the core loop.
 */

import { Logger, ChildLogger, getLogger } from './utils/logger.js';
import type { ToolResult, ToolDefinition, ToolContext } from './tools/definitions.js';
import type { EngineEvent } from './engine.js';

// ─── Plugin Manifest ──────────────────────────────────────────────────────

/**
 * The manifest describes a plugin's identity, configuration schema,
 * and which hooks it wants to subscribe to.
 *
 * This is what a plugin author provides to register their extension.
 */
export interface PluginManifest {
  /** Globally unique plugin identifier (kebab-case, e.g. 'metrics-export') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version (semver) */
  version: string;
  /** Author / maintainer */
  author?: string;
  /** Short description */
  description?: string;
  /** Configuration schema — validated before init() is called */
  configSchema?: PluginConfigField[];
  /** Hooks this plugin wants to subscribe to */
  hooks: PluginHookName[];
}

export interface PluginConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
}

// ─── Plugin Interface ──────────────────────────────────────────────────────

/**
 * A plugin is an object that implements this interface.
 * The manifest declares metadata; the methods define lifecycle.
 */
export interface Plugin {
  /** Plugin metadata and hook subscriptions */
  manifest: PluginManifest;
  /** Called once when the plugin is loaded — validate config, open resources */
  init(context: PluginContext): Promise<void>;
  /** Called once when the plugin is unloaded — close resources, flush state */
  destroy(): Promise<void>;
  /** Hook handler — called for each subscribed hook event */
  onHook(event: PluginHookEvent): Promise<PluginHookResult | void>;
}

// ─── Plugin Context (Sandboxed) ────────────────────────────────────────────

/**
 * The context passed to plugins. This is a deliberately limited view
 * of the engine — plugins cannot reach into core internals.
 */
export interface PluginContext {
  /** Plugin's own logger (child of the core logger, tagged with plugin id) */
  log: ChildLogger;
  /** Plugin's own configuration (validated against configSchema) */
  config: Record<string, unknown>;
  /** Read-only access to registered tool definitions */
  listTools(): ToolDefinition[];
  /** Emit a custom event visible to the engine and other plugins */
  emit(event: PluginCustomEvent): void;
  /** Workspace root directory (read-only path) */
  workspaceRoot: string;
}

// ─── Hook Events ───────────────────────────────────────────────────────────

export type PluginHookName = 'beforeTool' | 'afterTool' | 'beforeResponse' | 'afterResponse' | 'onMessage';

export interface PluginHookEvent {
  /** Which hook triggered this event */
  hook: PluginHookName;
  /** Session ID */
  sessionId: string;
  /** Timestamp (ISO) */
  timestamp: string;
  /** Hook-specific payload */
  payload: BeforeToolPayload | AfterToolPayload | BeforeResponsePayload | AfterResponsePayload | OnMessagePayload;
}

export interface BeforeToolPayload {
  toolId: string;
  params: Record<string, unknown>;
}

export interface AfterToolPayload {
  toolId: string;
  params: Record<string, unknown>;
  result: ToolResult;
}

export interface BeforeResponsePayload {
  content: string;
  toolCalls: { toolId: string; params: Record<string, unknown> }[];
}

export interface AfterResponsePayload {
  content: string;
  toolCalls: { toolId: string; params: Record<string, unknown> }[];
  durationMs: number;
}

export interface OnMessagePayload {
  content: string;
  senderId: string;
  senderName: string;
  channelId: string;
}

// ─── Hook Result ───────────────────────────────────────────────────────────

/**
 * What a plugin returns from a hook handler.
 * - `allow` (default): continue normally
 * - `modify`: replace the payload with updated values
 * - `block`: stop the action — the block reason becomes the tool/result error
 */
export interface PluginHookResult {
  action: 'allow' | 'modify' | 'block';
  /** When action='modify', the modified payload fields */
  modified?: Partial<BeforeToolPayload & AfterToolPayload & BeforeResponsePayload>;
  /** When action='block', the reason shown in logs / to user */
  blockReason?: string;
}

// ─── Custom Plugin Events ──────────────────────────────────────────────────

export interface PluginCustomEvent {
  /** Plugin that emitted this event */
  pluginId: string;
  /** Event name (kebab-case) */
  name: string;
  /** Arbitrary event data */
  data: Record<string, unknown>;
}

// ─── Plugin Manager ────────────────────────────────────────────────────────

/**
 * Manages plugin lifecycle: registration, validation, init, hooks, teardown.
 * The engine owns one of these and routes hook events through it.
 */
export class PluginManager {
  private plugins: Map<string, PluginEntry> = new Map();
  private hookIndex: Map<PluginHookName, string[]> = new Map();
  private customEventHandlers: ((event: PluginCustomEvent) => void)[] = [];
  private log: Logger | ChildLogger;
  private toolDefinitions: () => ToolDefinition[];
  private workspaceRoot: string;

  constructor(opts: {
    workspaceRoot: string;
    /** Function that returns current tool definitions (read-only access for plugins) */
    getToolDefinitions: () => ToolDefinition[];
    logger?: Logger | ChildLogger;
  }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.toolDefinitions = opts.getToolDefinitions;
    this.log = opts.logger ?? getLogger('plugin-manager');
  }

  // ─── Registration ──────────────────────────────────────────────────────

  /**
   * Register a plugin. Validates the manifest, checks for ID conflicts,
   * and calls init() with a sandboxed context.
   */
  async register(plugin: Plugin, config: Record<string, unknown> = {}): Promise<void> {
    const { manifest } = plugin;

    // Validate manifest
    const manifestErrors = validateManifest(manifest);
    if (manifestErrors.length > 0) {
      throw new PluginRegistrationError(manifest.id, `Invalid manifest: ${manifestErrors.join('; ')}`);
    }

    // Check for duplicate ID
    if (this.plugins.has(manifest.id)) {
      throw new PluginRegistrationError(manifest.id, `Plugin already registered with id '${manifest.id}'`);
    }

    // Validate config against schema
    const validatedConfig = validatePluginConfig(manifest, config);

    // Create sandboxed context
    const context: PluginContext = {
      log: (this.log instanceof Logger ? this.log.child(manifest.id) : getLogger(`plugin:${manifest.id}`)) as ChildLogger,
      config: validatedConfig,
      listTools: () => this.toolDefinitions(),
      emit: (event) => this.handleCustomEvent(manifest.id, event),
      workspaceRoot: this.workspaceRoot,
    };

    // Store entry before init so we can destroy if init fails
    const entry: PluginEntry = {
      plugin,
      manifest,
      config: validatedConfig,
      state: 'initializing',
      context,
    };
    this.plugins.set(manifest.id, entry);

    // Call init
    try {
      await plugin.init(context);
      entry.state = 'active';
      this.log.info(`Plugin registered: ${manifest.id} v${manifest.version}`, {
        name: manifest.name,
        hooks: manifest.hooks,
      });
    } catch (err) {
      entry.state = 'error';
      this.plugins.delete(manifest.id);
      throw new PluginRegistrationError(
        manifest.id,
        `init() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Index hooks
    for (const hook of manifest.hooks) {
      const list = this.hookIndex.get(hook) ?? [];
      list.push(manifest.id);
      this.hookIndex.set(hook, list);
    }
  }

  /**
   * Unregister a plugin by ID. Calls destroy() on the plugin.
   */
  async unregister(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.log.warn(`Cannot unregister unknown plugin: ${pluginId}`);
      return;
    }

    // Remove from hook index
    for (const [hook, ids] of this.hookIndex) {
      this.hookIndex.set(hook, ids.filter(id => id !== pluginId));
    }

    // Call destroy
    try {
      await entry.plugin.destroy();
    } catch (err) {
      this.log.error(`Error destroying plugin ${pluginId}:`, { error: String(err) });
    }

    this.plugins.delete(pluginId);
    entry.state = 'destroyed';
    this.log.info(`Plugin unregistered: ${pluginId}`);
  }

  /**
   * Unregister all plugins. Called during engine shutdown.
   */
  async unregisterAll(): Promise<void> {
    const ids = Array.from(this.plugins.keys());
    for (const id of ids) {
      await this.unregister(id);
    }
  }

  // ─── Hook Execution ────────────────────────────────────────────────────

  /**
   * Execute all plugins subscribed to a hook, in registration order.
   * Returns the aggregated result — if any plugin blocks, the action is blocked.
   * If multiple plugins modify, later plugins see earlier modifications.
   */
  async executeHook(event: PluginHookEvent): Promise<AggregatedHookResult> {
    const subscribers = this.hookIndex.get(event.hook) ?? [];

    if (subscribers.length === 0) {
      return { action: 'allow' };
    }

    let currentPayload = event.payload;
    let blocked: { pluginId: string; reason: string } | null = null;

    for (const pluginId of subscribers) {
      const entry = this.plugins.get(pluginId);
      if (!entry || entry.state !== 'active') continue;

      try {
        const result = await entry.plugin.onHook({
          ...event,
          payload: currentPayload,
        });

        if (!result) continue;

        if (result.action === 'block') {
          blocked = { pluginId, reason: result.blockReason ?? 'blocked by plugin' };
          this.log.warn(`Plugin ${pluginId} blocked ${event.hook}`, {
            reason: result.blockReason,
          });
          break; // First block wins
        }

        if (result.action === 'modify' && result.modified) {
          // Merge modifications into current payload
          currentPayload = mergePayload(currentPayload, result.modified);
        }
      } catch (err) {
        this.log.error(`Plugin ${pluginId} threw in hook ${event.hook}:`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't block on plugin errors — log and continue
      }
    }

    if (blocked) {
      return { action: 'block', blockReason: blocked.reason, blockedBy: blocked.pluginId };
    }

    // Check if payload was modified
    const wasModified = currentPayload !== event.payload;
    return {
      action: wasModified ? 'modify' : 'allow',
      modifiedPayload: wasModified ? currentPayload : undefined,
    };
  }

  // ─── Custom Events ─────────────────────────────────────────────────────

  onCustomEvent(handler: (event: PluginCustomEvent) => void): void {
    this.customEventHandlers.push(handler);
  }

  private handleCustomEvent(pluginId: string, event: PluginCustomEvent): void {
    const fullEvent: PluginCustomEvent = { ...event, pluginId };
    for (const handler of this.customEventHandlers) {
      try {
        handler(fullEvent);
      } catch (err) {
        this.log.error(`Custom event handler error for plugin ${pluginId}:`, {
          error: String(err),
        });
      }
    }
  }

  // ─── Introspection ─────────────────────────────────────────────────────

  /** List all registered plugins */
  list(): PluginInfo[] {
    return Array.from(this.plugins.values()).map(e => ({
      id: e.manifest.id,
      name: e.manifest.name,
      version: e.manifest.version,
      state: e.state,
      hooks: e.manifest.hooks,
    }));
  }

  /** Get a specific plugin's info */
  get(pluginId: string): PluginInfo | undefined {
    const entry = this.plugins.get(pluginId);
    if (!entry) return undefined;
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      state: entry.state,
      hooks: entry.manifest.hooks,
    };
  }

  /** Count active plugins */
  count(): number {
    return this.plugins.size;
  }
}

// ─── Aggregated Hook Result ───────────────────────────────────────────────

export interface AggregatedHookResult {
  action: 'allow' | 'modify' | 'block';
  /** If action='modify', the payload after all plugin modifications */
  modifiedPayload?: BeforeToolPayload | AfterToolPayload | BeforeResponsePayload | AfterResponsePayload | OnMessagePayload;
  /** If action='block', the reason */
  blockReason?: string;
  /** Plugin that blocked (if any) */
  blockedBy?: string;
}

// ─── Plugin Entry (internal) ───────────────────────────────────────────────

interface PluginEntry {
  plugin: Plugin;
  manifest: PluginManifest;
  config: Record<string, unknown>;
  state: 'initializing' | 'active' | 'error' | 'destroyed';
  context: PluginContext;
}

// ─── Plugin Info (public) ─────────────────────────────────────────────────

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: 'initializing' | 'active' | 'error' | 'destroyed';
  hooks: PluginHookName[];
}

// ─── Plugin Registration Error ─────────────────────────────────────────────

export class PluginRegistrationError extends Error {
  readonly pluginId: string;

  constructor(pluginId: string, message: string) {
    super(`[Plugin:${pluginId}] ${message}`);
    this.name = 'PluginRegistrationError';
    this.pluginId = pluginId;
  }
}

// ─── Manifest Validation ───────────────────────────────────────────────────

const VALID_HOOKS: PluginHookName[] = ['beforeTool', 'afterTool', 'beforeResponse', 'afterResponse', 'onMessage'];

export function validateManifest(manifest: PluginManifest): string[] {
  const errors: string[] = [];

  // ID checks
  if (!manifest.id || typeof manifest.id !== 'string') {
    errors.push('manifest.id is required and must be a string');
  } else if (!/^[a-z0-9-]+$/.test(manifest.id)) {
    errors.push('manifest.id must be kebab-case (lowercase, digits, hyphens only)');
  } else if (manifest.id.length > 64) {
    errors.push('manifest.id must be 64 characters or fewer');
  }

  // Name
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('manifest.name is required and must be a string');
  }

  // Version (basic semver check)
  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('manifest.version is required and must be a string');
  } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push('manifest.version should follow semver (e.g. 1.0.0)');
  }

  // Hooks
  if (!Array.isArray(manifest.hooks)) {
    errors.push('manifest.hooks must be an array');
  } else if (manifest.hooks.length === 0) {
    errors.push('manifest.hooks must contain at least one hook');
  } else {
    for (const hook of manifest.hooks) {
      if (!VALID_HOOKS.includes(hook)) {
        errors.push(`manifest.hooks contains invalid hook '${hook}' — valid: ${VALID_HOOKS.join(', ')}`);
      }
    }
  }

  // Config schema (if provided)
  if (manifest.configSchema !== undefined) {
    if (!Array.isArray(manifest.configSchema)) {
      errors.push('manifest.configSchema must be an array if provided');
    } else {
      for (const field of manifest.configSchema) {
        if (!field.name || typeof field.name !== 'string') {
          errors.push('configSchema field missing name');
        }
        if (!['string', 'number', 'boolean', 'array', 'object'].includes(field.type)) {
          errors.push(`configSchema field '${field.name}' has invalid type`);
        }
      }
    }
  }

  return errors;
}

// ─── Config Validation ──────────────────────────────────────────────────────

export function validatePluginConfig(
  manifest: PluginManifest,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!manifest.configSchema || manifest.configSchema.length === 0) {
    return config;
  }

  const result: Record<string, unknown> = {};

  for (const field of manifest.configSchema) {
    const value = config[field.name];

    if (value === undefined || value === null) {
      if (field.required) {
        if (field.default !== undefined) {
          result[field.name] = field.default;
        } else {
          throw new PluginRegistrationError(
            manifest.id,
            `Missing required config field: '${field.name}'`,
          );
        }
      } else if (field.default !== undefined) {
        result[field.name] = field.default;
      }
      continue;
    }

    // Type check
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== field.type) {
      throw new PluginRegistrationError(
        manifest.id,
        `Config field '${field.name}' expected ${field.type}, got ${actualType}`,
      );
    }

    // Enum check
    if (field.enum && !field.enum.includes(String(value))) {
      throw new PluginRegistrationError(
        manifest.id,
        `Config field '${field.name}' must be one of: ${field.enum.join(', ')}`,
      );
    }

    // Min/max for numbers
    if (field.type === 'number') {
      if (field.min !== undefined && (value as number) < field.min) {
        throw new PluginRegistrationError(
          manifest.id,
          `Config field '${field.name}' must be >= ${field.min}`,
        );
      }
      if (field.max !== undefined && (value as number) > field.max) {
        throw new PluginRegistrationError(
          manifest.id,
          `Config field '${field.name}' must be <= ${field.max}`,
        );
      }
    }

    result[field.name] = value;
  }

  return result;
}

// ─── Payload Merge Helper ─────────────────────────────────────────────────

function mergePayload(
  current: BeforeToolPayload | AfterToolPayload | BeforeResponsePayload | AfterResponsePayload | OnMessagePayload,
  modified: Partial<BeforeToolPayload & AfterToolPayload & BeforeResponsePayload>,
): BeforeToolPayload | AfterToolPayload | BeforeResponsePayload | AfterResponsePayload | OnMessagePayload {
  return { ...current, ...modified } as BeforeToolPayload & AfterToolPayload & BeforeResponsePayload & AfterResponsePayload & OnMessagePayload;
}