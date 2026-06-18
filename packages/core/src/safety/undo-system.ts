/**
 * Lodestone — Undo System
 *
 * Records agent actions that might need to be reversed.
 * Not all actions are reversible — file_deleted can restore from backup,
 * email_sent is irreversible (but could send a recall follow-up).
 *
 * Custom reverse handlers can be registered for tool-specific undo logic.
 * Default retention: 7 days, configurable via cleanup().
 *
 * Storage: data/undo-history.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type UndoableActionType =
  | 'email_sent'
  | 'file_written'
  | 'file_deleted'
  | 'tool_executed'
  | 'config_changed'
  | 'memory_stored'
  | 'message_sent';

export interface UndoableAction {
  /** Unique action ID */
  id: string;
  /** What type of action was performed */
  type: UndoableActionType;
  /** When the action occurred */
  timestamp: string;
  /** Human-readable description */
  description: string;
  /** Whether this action can be reversed */
  reversible: boolean;
  /** Additional action-specific data */
  metadata: Record<string, unknown>;
  /** Name of the reverse handler to call (for programmatic undo) */
  reverseFn?: string;
  /** Data needed to reverse the action */
  reverseData?: Record<string, unknown>;
  /** Whether this action was undone */
  undone?: boolean;
  /** When it was undone */
  undoneAt?: string;
}

export interface UndoResult {
  success: boolean;
  message: string;
  sideEffects?: string[];
}

export type ReverseHandler = (
  data: Record<string, unknown>,
) => Promise<UndoResult>;

// ─── Default Reversibility ───────────────────────────────────────────────────

const DEFAULT_REVERSIBLE: Record<UndoableActionType, boolean> = {
  file_written: true,
  file_deleted: true,
  config_changed: true,
  memory_stored: true,
  tool_executed: false, // depends on custom handler
  email_sent: false, // irreversible — can only send recall
  message_sent: false, // irreversible — external system
};

const DEFAULT_RETENTION_DAYS = 7;

// ─── Undo System ─────────────────────────────────────────────────────────────

export class UndoSystem {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly logger = new Logger({ stdout: true, minLevel: 'info' });
  private actions: UndoableAction[] = [];
  private reverseHandlers: Map<string, ReverseHandler> = new Map();
  private loaded = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'undo-history.json');
  }

  /** Load action history from disk */
  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await readFile(this.filePath, 'utf-8');
      this.actions = JSON.parse(data);
      this.logger.info(`[UndoSystem] Loaded ${this.actions.length} actions`);
    } catch {
      this.actions = [];
      await this.save();
    }
    this.loaded = true;
  }

  /**
   * Record an action that might need undoing.
   * Returns the action ID for later undo.
   */
  recordAction(action: Omit<UndoableAction, 'id' | 'timestamp'>): string {
    const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fullAction: UndoableAction = {
      ...action,
      id,
      timestamp: new Date().toISOString(),
    };

    this.actions.push(fullAction);
    void this.save();

    this.logger.info(`[UndoSystem] Recorded ${action.type}: ${action.description}`, {
      actionId: id,
      reversible: action.reversible,
    });
    return id;
  }

  /**
   * Get recent undoable actions, most recent first.
   */
  getRecentActions(limit = 20): UndoableAction[] {
    return [...this.actions]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  /**
   * Undo a specific action by ID.
   * Uses registered reverse handlers or built-in logic.
   */
  async undo(actionId: string): Promise<UndoResult> {
    const action = this.actions.find(a => a.id === actionId);
    if (!action) {
      return { success: false, message: `Action ${actionId} not found` };
    }

    if (action.undone) {
      return { success: false, message: `Action ${actionId} already undone at ${action.undoneAt}` };
    }

    if (!action.reversible) {
      return {
        success: false,
        message: `Action type '${action.type}' is not reversible. ${
          action.type === 'email_sent'
            ? 'Consider sending a follow-up recall email.'
            : action.type === 'message_sent'
              ? 'External messages cannot be unsent.'
              : 'No reverse handler available.'
        }`,
      };
    }

    // Try custom reverse handler first
    const handlerKey = action.reverseFn || action.type;
    const handler = this.reverseHandlers.get(handlerKey);
    if (handler) {
      const data = { ...action.metadata, ...action.reverseData };
      const result = await handler(data);
      if (result.success) {
        action.undone = true;
        action.undoneAt = new Date().toISOString();
        void this.save();
        this.logger.info(`[UndoSystem] Undone ${actionId} via handler: ${result.message}`);
      }
      return result;
    }

    // Built-in reverse logic for known types
    const builtInResult = await this.builtInReverse(action);
    if (builtInResult.success) {
      action.undone = true;
      action.undoneAt = new Date().toISOString();
      void this.save();
      this.logger.info(`[UndoSystem] Undone ${actionId} built-in: ${builtInResult.message}`);
    }
    return builtInResult;
  }

  /**
   * Undo the last action of a specific type.
   */
  async undoLast(type: UndoableActionType): Promise<UndoResult> {
    const actionsOfType = [...this.actions]
      .filter(a => a.type === type && !a.undone)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (actionsOfType.length === 0) {
      return { success: false, message: `No undoable actions of type '${type}'` };
    }

    return this.undo(actionsOfType[0].id);
  }

  /**
   * Get full undo history (all actions, chronological).
   */
  getHistory(): UndoableAction[] {
    return [...this.actions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Check if an action type is reversible.
   */
  isReversible(type: UndoableActionType): boolean {
    return DEFAULT_REVERSIBLE[type] ?? false;
  }

  /**
   * Clear old actions. Returns count of removed actions.
   */
  cleanup(maxAgeDays = DEFAULT_RETENTION_DAYS): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString();

    const before = this.actions.length;
    this.actions = this.actions.filter(a => a.timestamp >= cutoffStr || !a.undone);
    const removed = before - this.actions.length;

    if (removed > 0) {
      void this.save();
      this.logger.info(`[UndoSystem] Cleaned up ${removed} actions older than ${maxAgeDays} days`);
    }
    return removed;
  }

  /**
   * Register a custom reverse handler for an action type.
   */
  registerReverseHandler(actionType: string, handler: ReverseHandler): void {
    this.reverseHandlers.set(actionType, handler);
    this.logger.debug(`[UndoSystem] Registered reverse handler for '${actionType}'`);
  }

  /** Get action by ID */
  getAction(actionId: string): UndoableAction | null {
    return this.actions.find(a => a.id === actionId) ?? null;
  }

  /** Get stats */
  getStats(): { total: number; undone: number; reversible: number; pending: number } {
    const total = this.actions.length;
    const undone = this.actions.filter(a => a.undone).length;
    const reversible = this.actions.filter(a => a.reversible).length;
    const pending = this.actions.filter(a => a.reversible && !a.undone).length;
    return { total, undone, reversible, pending };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Built-in reverse logic for known action types.
   * Falls back to "not reversible" if no logic exists.
   */
  private async builtInReverse(action: UndoableAction): Promise<UndoResult> {
    switch (action.type) {
      case 'file_written': {
        const filePath = action.metadata.filePath as string | undefined;
        const previousContent = action.reverseData?.previousContent as string | undefined;
        if (!filePath) {
          return { success: false, message: 'No file path in action metadata' };
        }
        if (previousContent !== undefined) {
          const { writeFileSync } = await import('fs');
          try {
            writeFileSync(filePath, previousContent);
            return {
              success: true,
              message: `Restored ${filePath} to previous content`,
              sideEffects: [`File ${filePath} overwritten with original content`],
            };
          } catch (err) {
            return { success: false, message: `Failed to restore file: ${err}` };
          }
        }
        return { success: false, message: 'No previous content to restore' };
      }

      case 'file_deleted': {
        const filePath = action.metadata.filePath as string | undefined;
        const backupPath = action.reverseData?.backupPath as string | undefined;
        if (!filePath) {
          return { success: false, message: 'No file path in action metadata' };
        }
        if (backupPath && existsSync(backupPath)) {
          const { copyFileSync } = await import('fs');
          try {
            copyFileSync(backupPath, filePath);
            return {
              success: true,
              message: `Restored ${filePath} from backup ${backupPath}`,
              sideEffects: [`File restored from ${backupPath}`],
            };
          } catch (err) {
            return { success: false, message: `Failed to restore from backup: ${err}` };
          }
        }
        return { success: false, message: 'No backup available to restore from' };
      }

      case 'config_changed': {
        const configPath = action.metadata.configPath as string | undefined;
        const previousValue = action.reverseData?.previousValue as unknown;
        if (!configPath) {
          return { success: false, message: 'No config path in action metadata' };
        }
        // Config restoration requires knowledge of the config format
        // Store the previous value in reverseData for restoration
        return {
          success: true,
          message: `Config ${configPath} can be restored to previous value. Use a registered handler for automatic restoration.`,
          sideEffects: [`Previous value: ${JSON.stringify(previousValue)}`],
        };
      }

      case 'memory_stored': {
        const key = action.metadata.key as string | undefined;
        if (!key) {
          return { success: false, message: 'No memory key in action metadata' };
        }
        // Memory undo = delete the stored entry
        // This is a logical undo — the memory system should handle deletion
        return {
          success: true,
          message: `Memory entry '${key}' marked for deletion. Remove from memory system to complete undo.`,
          sideEffects: [`Memory key '${key}' should be removed`],
        };
      }

      default:
        return {
          success: false,
          message: `No built-in reverse for action type '${action.type}'. Register a custom handler.`,
        };
    }
  }

  private async save(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    await writeFile(this.filePath, JSON.stringify(this.actions, null, 2), 'utf-8');
  }
}