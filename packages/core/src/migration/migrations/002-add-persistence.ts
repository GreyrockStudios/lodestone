/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Migration 002 — Add Persistence
 *
 * Ensures the sessions.db file exists for session persistence.
 * Creates the database file if not present.
 */

import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import type { Migration } from '../migration-system.js';

export function createAddPersistenceMigration(dataDir: string): Migration {
  return {
    version: 2,
    name: 'add-persistence',
    description: 'Ensure sessions.db exists for session persistence',

    async up(): Promise<boolean> {
      const dbDir = join(dataDir, 'sessions');
      const dbPath = join(dbDir, 'sessions.db');

      // Ensure the directory exists
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Create empty db file if it doesn't exist
      if (!existsSync(dbPath)) {
        // Create the file (will be initialized by better-sqlite3 on first use)
        const fd = openSync(dbPath, 'w');
        closeSync(fd);
      }

      return true;
    },

    async down(): Promise<boolean> {
      // Don't delete the db file on rollback — data could be valuable.
      // Mark as successful so rollback can proceed.
      return true;
    },
  };
}