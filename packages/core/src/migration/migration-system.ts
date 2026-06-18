/**
 * Lodestone Core — Migration System
 *
 * Manages schema and data migrations for the Lodestone engine.
 * Tracks the current version, runs pending migrations in order,
 * records each migration in a log file, and rolls back on failure.
 *
 * No external dependencies — pure TypeScript + Node built-ins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { Logger, getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Migration {
  /** Version number (sequential, e.g. 1, 2, 3) */
  version: number;
  /** Human-readable name (e.g., 'initial-schema') */
  name: string;
  /** Run the migration — returns true on success */
  up(): Promise<boolean>;
  /** Roll back the migration — optional, returns true on success */
  down?(): Promise<boolean>;
  /** Optional description for logging */
  description?: string;
}

export interface MigrationResult {
  /** Whether all migrations succeeded */
  success: boolean;
  /** Number of migrations executed */
  executed: number;
  /** Version before migrations ran */
  fromVersion: number;
  /** Version after migrations ran */
  toVersion: number;
  /** Errors encountered (empty if success) */
  errors: string[];
  /** Names of migrations that ran */
  executedMigrations: string[];
}

export interface MigrationStatus {
  /** Current schema version */
  currentVersion: number;
  /** Number of pending migrations */
  pendingCount: number;
  /** List of pending migration names */
  pending: string[];
  /** ISO timestamp of last migration (or null) */
  lastMigrationDate: string | null;
  /** Total migrations ever run */
  totalRun: number;
}

// ─── Migration System ────────────────────────────────────────────────────────

export class MigrationSystem {
  private migrations: Migration[] = [];
  private currentVersion: number;
  private readonly dataDir: string;
  private readonly versionFile: string;
  private readonly logFile: string;
  private readonly logger: Logger;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.versionFile = join(dataDir, '.migration-version');
    this.logFile = join(dataDir, 'migrations.log');
    this.logger = getLogger('migration') as Logger;

    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Read current version
    this.currentVersion = this.readVersion();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Register a migration. Must be called before runMigrations(). */
  registerMigration(migration: Migration): void {
    // Prevent duplicate version numbers
    const existing = this.migrations.find(m => m.version === migration.version);
    if (existing) {
      throw new Error(
        `Migration version ${migration.version} already registered: '${existing.name}'`
      );
    }
    this.migrations.push(migration);
    // Keep sorted by version
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Run all pending migrations in version order.
   * Rolls back on failure (calls down() if available).
   * Records each migration in the log file.
   */
  async runMigrations(): Promise<MigrationResult> {
    const fromVersion = this.currentVersion;
    const errors: string[] = [];
    const executedMigrations: string[] = [];

    // Find pending migrations
    const pending = this.migrations.filter(m => m.version > this.currentVersion);

    if (pending.length === 0) {
      this.logger.info('No pending migrations', { currentVersion: this.currentVersion });
      return {
        success: true,
        executed: 0,
        fromVersion,
        toVersion: this.currentVersion,
        errors: [],
        executedMigrations: [],
      };
    }

    this.logger.info(`Running ${pending.length} pending migration(s)`, {
      from: fromVersion,
      to: pending[pending.length - 1].version,
    });

    // Execute each migration in order
    for (const migration of pending) {
      const start = Date.now();
      this.logger.info(`Running migration ${migration.version}: ${migration.name}`);

      try {
        const success = await migration.up();
        const durationMs = Date.now() - start;

        if (!success) {
          throw new Error(`Migration ${migration.name} returned false`);
        }

        // Update current version
        this.currentVersion = migration.version;
        this.writeVersion(migration.version);

        // Log the migration
        this.logMigration(migration, 'up', 'success', durationMs);

        executedMigrations.push(migration.name);
        this.logger.info(`✅ Migration ${migration.version} (${migration.name}) completed in ${durationMs}ms`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - start;

        this.logger.error(`❌ Migration ${migration.version} (${migration.name}) failed: ${errorMsg}`);
        this.logMigration(migration, 'up', 'failed', durationMs, errorMsg);
        errors.push(`${migration.name}: ${errorMsg}`);

        // Attempt rollback — reverse through executed migrations
        this.logger.info('Rolling back...');
        for (let i = executedMigrations.length - 1; i >= 0; i--) {
          const doneMigration = this.migrations.find(m => m.name === executedMigrations[i]);
          if (!doneMigration?.down) {
            this.logger.warn(`No down() for migration ${doneMigration?.name} — skipping rollback`);
            continue;
          }
          try {
            const downSuccess = await doneMigration.down();
            if (downSuccess) {
              this.logger.info(`Rolled back: ${doneMigration.name}`);
              this.logMigration(doneMigration, 'down', 'success', 0, undefined, true);
            } else {
              this.logger.warn(`Rollback returned false for: ${doneMigration.name}`);
              this.logMigration(doneMigration, 'down', 'failed', 0, 'returned false', true);
            }
          } catch (downErr) {
            const downMsg = downErr instanceof Error ? downErr.message : String(downErr);
            this.logger.error(`Rollback failed for ${doneMigration.name}: ${downMsg}`);
            this.logMigration(doneMigration, 'down', 'failed', 0, downMsg, true);
          }
        }

        // Revert version to pre-migration state
        this.currentVersion = fromVersion;
        this.writeVersion(fromVersion);

        return {
          success: false,
          executed: executedMigrations.length,
          fromVersion,
          toVersion: fromVersion,
          errors,
          executedMigrations,
        };
      }
    }

    this.logger.info(`All migrations complete. Version: ${fromVersion} → ${this.currentVersion}`);
    return {
      success: true,
      executed: executedMigrations.length,
      fromVersion,
      toVersion: this.currentVersion,
      errors: [],
      executedMigrations,
    };
  }

  /** Get the current migration status */
  getStatus(): MigrationStatus {
    const pending = this.migrations.filter(m => m.version > this.currentVersion);
    const lastDate = this.getLastMigrationDate();
    const totalRun = this.countExecutedMigrations();

    return {
      currentVersion: this.currentVersion,
      pendingCount: pending.length,
      pending: pending.map(m => `v${m.version} — ${m.name}`),
      lastMigrationDate: lastDate,
      totalRun,
    };
  }

  /** Get the current version */
  getVersion(): number {
    return this.currentVersion;
  }

  /** List all registered migrations */
  listMigrations(): Migration[] {
    return [...this.migrations];
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private readVersion(): number {
    if (!existsSync(this.versionFile)) {
      return 0;
    }
    try {
      const content = readFileSync(this.versionFile, 'utf-8').trim();
      const version = parseInt(content, 10);
      return isNaN(version) ? 0 : version;
    } catch {
      return 0;
    }
  }

  private writeVersion(version: number): void {
    const dir = dirname(this.versionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.versionFile, String(version), 'utf-8');
  }

  private logMigration(
    migration: Migration,
    direction: 'up' | 'down',
    status: 'success' | 'failed',
    durationMs: number,
    error?: string,
    isRollback?: boolean,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      version: migration.version,
      name: migration.name,
      direction,
      status,
      durationMs,
      ...(error ? { error } : {}),
      ...(isRollback ? { rollback: true } : {}),
    };

    const line = JSON.stringify(entry) + '\n';

    // Ensure log directory exists
    const logDir = dirname(this.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    appendFileSync(this.logFile, line, 'utf-8');
  }

  private getLastMigrationDate(): string | null {
    if (!existsSync(this.logFile)) return null;
    try {
      const content = readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length === 0) return null;

      // Find the last successful 'up' entry
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.direction === 'up' && entry.status === 'success') {
            return entry.timestamp;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private countExecutedMigrations(): number {
    if (!existsSync(this.logFile)) return 0;
    try {
      const content = readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n');
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.direction === 'up' && entry.status === 'success' && !entry.rollback) {
            count++;
          }
        } catch {
          continue;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }
}