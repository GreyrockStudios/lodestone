/**
 * Lodestone Core — Migration System
 *
 * Public API for the migration system.
 */

import { MigrationSystem, type Migration } from './migration-system.js';
import { createInitialSchemaMigration } from './migrations/001-initial-schema.js';
import { createAddPersistenceMigration } from './migrations/002-add-persistence.js';
import { createAddDashboardConfigMigration } from './migrations/003-add-dashboard-config.js';

export { MigrationSystem, type Migration, type MigrationResult, type MigrationStatus } from './migration-system.js';
export { createInitialSchemaMigration } from './migrations/001-initial-schema.js';
export { createAddPersistenceMigration } from './migrations/002-add-persistence.js';
export { createAddDashboardConfigMigration } from './migrations/003-add-dashboard-config.js';

/**
 * Register all built-in migrations with a MigrationSystem instance.
 * @param system The migration system to register migrations into
 * @param dataDir The data directory path
 */
export function registerBuiltinMigrations(system: MigrationSystem, dataDir: string): void {
  const migrations: Migration[] = [
    createInitialSchemaMigration(dataDir),
    createAddPersistenceMigration(dataDir),
    createAddDashboardConfigMigration(dataDir),
  ];

  for (const migration of migrations) {
    system.registerMigration(migration);
  }
}