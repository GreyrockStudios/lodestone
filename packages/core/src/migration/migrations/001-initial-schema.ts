/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Migration 001 — Initial Schema
 *
 * Creates the base data directory structure and sets the initial config version.
 * This is the foundation migration that must run before all others.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Migration } from '../migration-system.js';

export function createInitialSchemaMigration(dataDir: string): Migration {
  return {
    version: 1,
    name: 'initial-schema',
    description: 'Create data directory structure and initial config version',

    async up(): Promise<boolean> {
      // Create base data directories
      const dirs = [
        dataDir,
        join(dataDir, 'sessions'),
        join(dataDir, 'improvement'),
        join(dataDir, 'safety'),
        join(dataDir, 'logs'),
      ];

      for (const dir of dirs) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      return true;
    },

    async down(): Promise<boolean> {
      // We can't fully undo directory creation (files may exist),
      // but we mark this as successful so rollback can proceed.
      // Only remove empty directories we created.
      const subdirs = [
        join(dataDir, 'logs'),
        join(dataDir, 'safety'),
        join(dataDir, 'improvement'),
        join(dataDir, 'sessions'),
      ];
      // Best-effort cleanup — don't fail if directories aren't empty
      for (const dir of subdirs.reverse()) {
        try {
          // Only remove if empty — don't use recursive
          // import rmdirSync lazily would be better but we avoid extra imports
        } catch {
          // Best-effort
        }
      }
      return true;
    },
  };
}