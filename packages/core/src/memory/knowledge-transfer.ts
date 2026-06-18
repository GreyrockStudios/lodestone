/**
 * Lodestone — Cross-Agent Knowledge Transfer
 *
 * Enables structured knowledge sharing between agents. Knowledge items
 * carry confidence scores and provenance. Items below a threshold are
 * rejected. Verified items skip validation.
 *
 * Transfer history is append-only — once recorded, transfers cannot be
 * modified, only accepted or left pending.
 *
 * Storage: data/knowledge-transfers.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type KnowledgeType = 'fact' | 'skill' | 'preference' | 'decision' | 'rule';

export interface TransferItem {
  /** What kind of knowledge */
  type: KnowledgeType;
  /** The knowledge content itself */
  content: string;
  /** Confidence score (0-1) — items below 0.5 are rejected */
  confidence: number;
  /** Where this knowledge came from */
  source: string;
  /** Whether this item has been verified by a trusted source */
  verified: boolean;
}

export interface TransferPackage {
  /** Unique transfer ID */
  id: string;
  /** Agent sending the knowledge */
  sourceAgent: string;
  /** Agent receiving the knowledge */
  targetAgent: string;
  /** When the transfer was created */
  createdAt: string;
  /** Knowledge items in this transfer */
  knowledge: TransferItem[];
  /** Transfer metadata */
  metadata: {
    /** Why this transfer is happening */
    reason: string;
    /** Optional session ID for context */
    sessionId?: string;
  };
  /** Whether the transfer has been applied */
  applied: boolean;
  /** When the transfer was applied (if applicable) */
  appliedAt?: string;
}

export interface ReceiveResult {
  /** Items that passed validation */
  accepted: TransferItem[];
  /** Items that failed validation */
  rejected: TransferItem[];
  /** Human-readable summary */
  reason: string;
}

export interface ApplyResult {
  /** Number of items successfully applied to memory */
  applied: number;
  /** Number of items skipped (already present or invalid) */
  skipped: number;
}

// ─── Knowledge Transfer ───────────────────────────────────────────────────────

const MIN_CONFIDENCE = 0.5;

export class KnowledgeTransfer {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly logger = new Logger({ stdout: true, minLevel: 'info' });
  private transfers: TransferPackage[] = [];
  private loaded = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'knowledge-transfers.json');
  }

  /** Load transfers from disk */
  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await readFile(this.filePath, 'utf-8');
      this.transfers = JSON.parse(data);
      this.logger.info(`[KnowledgeTransfer] Loaded ${this.transfers.length} transfers`);
    } catch {
      this.transfers = [];
      await this.save();
    }
    this.loaded = true;
  }

  /**
   * Package knowledge for transfer to another agent.
   * Creates a TransferPackage and stores it.
   */
  packageKnowledge(
    sourceAgent: string,
    targetAgent: string,
    items: TransferItem[],
    reason: string,
    sessionId?: string,
  ): TransferPackage {
    const pkg: TransferPackage = {
      id: `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceAgent,
      targetAgent,
      createdAt: new Date().toISOString(),
      knowledge: items,
      metadata: { reason, sessionId },
      applied: false,
    };

    this.transfers.push(pkg);
    void this.save();
    this.logger.info(`[KnowledgeTransfer] Packaged ${items.length} items from ${sourceAgent} → ${targetAgent}`, {
      transferId: pkg.id,
      itemCount: items.length,
    });
    return pkg;
  }

  /**
   * Receive and validate a transfer package.
   * Items below 0.5 confidence are rejected (unless verified).
   * Verified items skip validation.
   */
  receivePackage(pkg: TransferPackage): ReceiveResult {
    const accepted: TransferItem[] = [];
    const rejected: TransferItem[] = [];

    for (const item of pkg.knowledge) {
      if (item.verified) {
        // Verified items skip validation entirely
        accepted.push(item);
      } else if (item.confidence < MIN_CONFIDENCE) {
        rejected.push(item);
      } else if (!item.content || item.content.trim().length === 0) {
        rejected.push(item);
      } else {
        accepted.push(item);
      }
    }

    // Store the received package if not already present
    const existing = this.transfers.find(t => t.id === pkg.id);
    if (!existing) {
      this.transfers.push({ ...pkg, applied: false });
      void this.save();
    }

    const reason =
      rejected.length === 0
        ? `All ${accepted.length} items accepted`
        : `${accepted.length} accepted, ${rejected.length} rejected (confidence < ${MIN_CONFIDENCE} or empty content)`;

    this.logger.info(`[KnowledgeTransfer] Received ${pkg.id}: ${reason}`);
    return { accepted, rejected, reason };
  }

  /**
   * List pending (unapplied) transfers for a specific agent.
   */
  listTransfers(agentId: string): TransferPackage[] {
    return this.transfers.filter(
      t => t.targetAgent === agentId && !t.applied,
    );
  }

  /**
   * Apply a transfer to the agent's memory system.
   * Stores each accepted item as a vector memory entry.
   */
  applyTransfer(transferId: string, memory: import('../memory/memory-system.js').MemorySystem): ApplyResult {
    const pkg = this.transfers.find(t => t.id === transferId);
    if (!pkg) {
      return { applied: 0, skipped: 0 };
    }

    if (pkg.applied) {
      this.logger.warn(`[KnowledgeTransfer] Transfer ${transferId} already applied`);
      return { applied: 0, skipped: pkg.knowledge.length };
    }

    let applied = 0;
    let skipped = 0;

    for (const item of pkg.knowledge) {
      // Re-validate at apply time
      if (!item.verified && item.confidence < MIN_CONFIDENCE) {
        skipped++;
        continue;
      }

      if (!item.content || item.content.trim().length === 0) {
        skipped++;
        continue;
      }

      // Store in vector memory asynchronously (fire-and-forget, but we track count synchronously)
      const key = `transfer_${pkg.id}_${applied}`;
      memory.vector.store(key, item.content, {
        category: item.type,
        importance: item.confidence,
        source: item.source,
        transferId: pkg.id,
      }).catch(err => {
        this.logger.error(`[KnowledgeTransfer] Failed to store item ${key}: ${err}`);
      });

      applied++;
    }

    // Mark as applied
    pkg.applied = true;
    pkg.appliedAt = new Date().toISOString();
    void this.save();

    this.logger.info(`[KnowledgeTransfer] Applied ${transferId}: ${applied} applied, ${skipped} skipped`);
    return { applied, skipped };
  }

  /**
   * Get transfer history between two agents.
   * Append-only — returns all past transfers, most recent first.
   */
  getHistory(sourceAgent: string, targetAgent: string): TransferPackage[] {
    return this.transfers
      .filter(t => t.sourceAgent === sourceAgent && t.targetAgent === targetAgent)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Export a transfer as JSON for external use.
   */
  exportTransfer(transferId: string): string {
    const pkg = this.transfers.find(t => t.id === transferId);
    if (!pkg) {
      return JSON.stringify({ error: 'Transfer not found', transferId });
    }
    return JSON.stringify(pkg, null, 2);
  }

  /** Get all transfers (for debugging/inspection) */
  getAllTransfers(): TransferPackage[] {
    return [...this.transfers];
  }

  /** Get a specific transfer by ID */
  getTransfer(transferId: string): TransferPackage | null {
    return this.transfers.find(t => t.id === transferId) ?? null;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    await writeFile(this.filePath, JSON.stringify(this.transfers, null, 2), 'utf-8');
  }
}