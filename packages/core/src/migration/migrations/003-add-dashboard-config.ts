/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Migration 003 — Add Dashboard Config
 *
 * Ensures the dashboard config section exists in the engine config.
 * This migration validates that dashboard configuration is present
 * and writes a default config file fragment if missing.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Migration } from '../migration-system.js';

export function createAddDashboardConfigMigration(dataDir: string): Migration {
  return {
    version: 3,
    name: 'add-dashboard-config',
    description: 'Ensure dashboard config section exists',

    async up(): Promise<boolean> {
      const configDir = join(dataDir, 'config');
      const dashboardConfigPath = join(configDir, 'dashboard.json');

      // Ensure config directory exists
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      // If dashboard config fragment already exists, leave it alone
      if (existsSync(dashboardConfigPath)) {
        return true;
      }

      // Write default dashboard config fragment
      const defaultConfig = {
        port: 3737,
        host: '127.0.0.1',
        dashboardDir: join(dataDir, 'dashboard'),
        corsOrigin: '*',
      };

      writeFileSync(dashboardConfigPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');

      return true;
    },

    async down(): Promise<boolean> {
      // Don't remove the config on rollback — user may have customized it.
      return true;
    },
  };
}