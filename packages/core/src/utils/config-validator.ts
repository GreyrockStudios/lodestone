/**
 * Lodestone Config Validator
 *
 * Validates lodestone.config.yaml/json against a schema.
 * Clear error messages on startup. No silent failures.
 *
 * No external dependencies — pure TypeScript validation.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ConfigError[];
  warnings: ConfigWarning[];
  config?: Record<string, unknown>;
}

export interface ConfigError {
  path: string;
  message: string;
  value?: unknown;
}

export interface ConfigWarning {
  path: string;
  message: string;
  value?: unknown;
}

export interface ConfigSchema {
  [key: string]: ConfigField;
}

export interface ConfigField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'path';
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: unknown[];
  items?: ConfigField;
  properties?: ConfigSchema;
  additionalProperties?: boolean;
  description?: string;
}

// ─── Lodestone Config Schema ────────────────────────────────────────────────

export const lodestoneSchema: ConfigSchema = {
  llm: {
    type: 'object',
    required: true,
    description: 'LLM provider configuration',
    properties: {
      default: {
        type: 'object',
        required: true,
        description: 'Default LLM provider',
        properties: {
          type: {
            type: 'string',
            required: true,
            enum: ['ollama', 'openai', 'anthropic', 'custom'],
            description: 'LLM provider type',
          },
          model: {
            type: 'string',
            required: true,
            description: 'Model identifier (e.g. glm-5.2:cloud)',
          },
          apiKey: {
            type: 'string',
            description: 'API key (can also use env var)',
          },
          baseUrl: {
            type: 'string',
            description: 'Base URL for API calls',
          },
          contextWindow: {
            type: 'number',
            min: 1024,
            max: 1000000,
            default: 128000,
            description: 'Context window size in tokens',
          },
          maxTokens: {
            type: 'number',
            min: 256,
            max: 131072,
            default: 8192,
            description: 'Max output tokens per response',
          },
          temperature: {
            type: 'number',
            min: 0,
            max: 2,
            default: 0.7,
            description: 'Sampling temperature',
          },
        },
      },
      routes: {
        type: 'array',
        description: 'Model routes for specific tasks',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string', required: true },
            type: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
      },
    },
  },
  workspaceRoot: {
    type: 'path',
    description: 'Workspace root directory (populated by config loader)',
  },
  identityDir: {
    type: 'path',
    description: 'Identity directory (populated by config loader)',
  },
  wikiRoot: {
    type: 'path',
    description: 'Wiki root directory (populated by config loader)',
  },
  memoryDir: {
    type: 'path',
    description: 'Memory/vector DB directory (populated by config loader)',
  },
  maxConcurrentTools: {
    type: 'number',
    min: 1,
    max: 50,
    default: 5,
    description: 'Maximum concurrent tool executions',
  },
  maxConcurrentJobs: {
    type: 'number',
    min: 1,
    max: 50,
    default: 4,
    description: 'Maximum concurrent scheduled jobs',
  },
  compactionThreshold: {
    type: 'number',
    min: 0.1,
    max: 0.9,
    default: 0.5,
    description: 'Session compaction threshold (fraction of context window)',
  },
  channels: {
    type: 'object',
    description: 'Channel configuration (Telegram, Discord, etc.)',
    properties: {
      telegram: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false },
          botToken: { type: 'string', description: 'Telegram bot token from @BotFather' },
          allowFrom: { type: 'array', items: { type: 'string' } },
        },
      },
      discord: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false },
          token: { type: 'string', description: 'Discord bot token' },
          allowFrom: { type: 'array', items: { type: 'string' } },
        },
      },
      webchat: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false },
          port: { type: 'number', min: 1, max: 65535, default: 3000 },
          corsOrigin: { type: 'string', description: 'CORS origin for webchat' },
        },
      },
    },
  },
  safety: {
    type: 'object',
    description: 'Safety subsystem configuration',
    properties: {
      dataDir: { type: 'path', description: 'Safety data directory' },
      customTiers: { type: 'object', description: 'Custom capability tier overrides' },
    },
  },
  dashboard: {
    type: 'object',
    description: 'Dashboard server configuration',
    properties: {
      port: { type: 'number', min: 1, max: 65535, default: 3002 },
      apiToken: { type: 'string', description: 'Bearer token for API auth' },
      corsOrigin: { type: 'string', description: 'CORS origin for dashboard' },
    },
  },
  logging: {
    type: 'object',
    description: 'Logging configuration',
    properties: {
      level: {
        type: 'string',
        enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
        default: 'info',
      },
      format: {
        type: 'string',
        enum: ['json', 'text'],
        default: 'text',
      },
      file: { type: 'path', description: 'Log file path (if set, logs go to file)' },
    },
  },
  // YAML config sections (parsed by config-loader, not validated here)
  workspace: {
    type: 'object',
    description: 'Workspace configuration',
    properties: {
      root: { type: 'path', description: 'Workspace root directory' },
    },
  },
  memory: {
    type: 'object',
    description: 'Memory system configuration',
    properties: {
      wiki: { type: 'object', description: 'Wiki configuration' },
      vectorDb: { type: 'object', description: 'Vector DB configuration' },
      scratch: { type: 'object', description: 'Scratch buffer configuration' },
    },
  },
  identity: {
    type: 'object',
    description: 'Identity configuration',
    properties: {
      dir: { type: 'path', description: 'Identity directory' },
    },
  },
  session: {
    type: 'object',
    description: 'Session configuration',
    properties: {
      compactionThreshold: { type: 'number', min: 0.1, max: 0.9 },
      keepRecentCount: { type: 'number', min: 1 },
      maxEntries: { type: 'number', min: 1 },
      pruneAfter: { type: 'string', description: 'Duration string (e.g. 7d)' },
    },
  },
  proactive: {
    type: 'object',
    description: 'Proactive intelligence configuration',
  },
  scheduler: {
    type: 'object',
    description: 'Scheduler configuration',
    properties: {
      maxConcurrent: { type: 'number', min: 1, max: 50 },
    },
  },
  // ─── Engine-level config sections ────────────────────────────────────────
  costTracking: {
    type: 'object',
    additionalProperties: true,
    description: 'Cost tracking configuration (monthly budget, pricing)',
  },
  modelRouting: {
    type: 'object',
    additionalProperties: true,
    description: 'Multi-model routing configuration (routes, escalation)',
  },
  webhooks: {
    type: 'object',
    additionalProperties: true,
    description: 'Webhook integration configuration (incoming/outgoing)',
  },
  abTesting: {
    type: 'object',
    additionalProperties: true,
    description: 'A/B prompt testing configuration',
  },
  email: {
    type: 'object',
    additionalProperties: true,
    description: 'Email channel configuration (IMAP/SMTP)',
  },
  calendar: {
    type: 'object',
    additionalProperties: true,
    description: 'Calendar integration configuration',
  },
  auth: {
    type: 'object',
    additionalProperties: true,
    description: 'Auth/multi-user configuration',
  },
};

// ─── Validator ───────────────────────────────────────────────────────────────

export class ConfigValidator {
  private schema: ConfigSchema;

  constructor(schema: ConfigSchema = lodestoneSchema) {
    this.schema = schema;
  }

  /** Validate a config object against the schema */
  validate(config: Record<string, unknown>): ValidationResult {
    const errors: ConfigError[] = [];
    const warnings: ConfigWarning[] = [];

    this.validateObject(config, this.schema, '', errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      config,
    };
  }

  /** Validate a config file (JSON or YAML-like) */
  validateFile(path: string): ValidationResult {
    if (!existsSync(path)) {
      return {
        valid: false,
        errors: [{ path: '', message: `Config file not found: ${path}` }],
        warnings: [],
      };
    }

    let config: Record<string, unknown>;
    try {
      const raw = readFileSync(path, 'utf-8');
      if (path.endsWith('.json')) {
        config = JSON.parse(raw);
      } else {
        // Simple YAML-ish parsing — for production use a real YAML parser
        // Most setups will use JSON
        config = JSON.parse(raw);
      }
    } catch (err) {
      return {
        valid: false,
        errors: [{ path: '', message: `Failed to parse config: ${err}` }],
        warnings: [],
      };
    }

    return this.validate(config);
  }

  private validateObject(
    obj: Record<string, unknown>,
    schema: ConfigSchema,
    basePath: string,
    errors: ConfigError[],
    warnings: ConfigWarning[],
  ): void {
    // Check required fields
    for (const [key, field] of Object.entries(schema)) {
      const path = basePath ? `${basePath}.${key}` : key;
      const value = obj[key];

      if (value === undefined || value === null) {
        if (field.required) {
          errors.push({
            path,
            message: `Required field "${path}" is missing`,
            value,
          });
        } else if (field.default !== undefined) {
          // Apply default — just warn
          warnings.push({
            path,
            message: `Using default value for "${path}": ${field.default}`,
            value: field.default,
          });
        }
        continue;
      }

      // Type check
      this.validateField(value, field, path, errors, warnings);
    }

    // Check for unknown fields
    for (const key of Object.keys(obj)) {
      const path = basePath ? `${basePath}.${key}` : key;
      if (!(key in schema)) {
        warnings.push({
          path,
          message: `Unknown field "${path}" — not in schema`,
          value: obj[key],
        });
      }
    }
  }

  private validateField(
    value: unknown,
    field: ConfigField,
    path: string,
    errors: ConfigError[],
    warnings: ConfigWarning[],
  ): void {
    // Type check
    if (!this.checkType(value, field.type)) {
      errors.push({
        path,
        message: `Expected ${field.type}, got ${typeof value}`,
        value,
      });
      return;
    }

    // Enum check
    if (field.enum && !field.enum.includes(value)) {
      errors.push({
        path,
        message: `Invalid value "${value}". Must be one of: ${field.enum.join(', ')}`,
        value,
      });
      return;
    }

    // Number range
    if (field.type === 'number' && typeof value === 'number') {
      if (field.min !== undefined && value < field.min) {
        errors.push({
          path,
          message: `Value ${value} is below minimum ${field.min}`,
          value,
        });
      }
      if (field.max !== undefined && value > field.max) {
        errors.push({
          path,
          message: `Value ${value} exceeds maximum ${field.max}`,
          value,
        });
      }
    }

    // Path check
    if (field.type === 'path' && typeof value === 'string') {
      const resolved = isAbsolute(value) ? value : resolve(value);
      if (!existsSync(resolved)) {
        warnings.push({
          path,
          message: `Path does not exist: ${resolved}`,
          value,
        });
      }
    }

    // Array items
    if (field.type === 'array' && Array.isArray(value) && field.items) {
      value.forEach((item, i) => {
        this.validateField(item, field.items!, `${path}[${i}]`, errors, warnings);
      });
    }

    // Object properties
    if (field.type === 'object' && typeof value === 'object' && value !== null && field.properties) {
      this.validateObject(value as Record<string, unknown>, field.properties, path, errors, warnings);
    }
  }

  private checkType(value: unknown, type: ConfigField['type']): boolean {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && !isNaN(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'path': return typeof value === 'string';
      default: return true;
    }
  }

  /** Apply defaults to a config object */
  applyDefaults(config: Record<string, unknown>): Record<string, unknown> {
    const result = { ...config };
    this.applyDefaultsRecursive(result, this.schema, '');
    return result;
  }

  private applyDefaultsRecursive(
    obj: Record<string, unknown>,
    schema: ConfigSchema,
    basePath: string,
  ): void {
    for (const [key, field] of Object.entries(schema)) {
      if (obj[key] === undefined || obj[key] === null) {
        if (field.default !== undefined) {
          obj[key] = field.default;
        }
        continue;
      }

      if (field.type === 'object' && typeof obj[key] === 'object' && obj[key] !== null && field.properties) {
        this.applyDefaultsRecursive(obj[key] as Record<string, unknown>, field.properties, basePath);
      }
    }
  }

  /** Generate a human-readable report */
  report(result: ValidationResult): string {
    const lines: string[] = [];

    if (result.valid) {
      lines.push('✅ Config is valid');
    } else {
      lines.push('❌ Config validation failed');
    }

    if (result.errors.length > 0) {
      lines.push(`\nErrors (${result.errors.length}):`);
      for (const err of result.errors) {
        lines.push(`  • ${err.path || '(root)'}: ${err.message}`);
      }
    }

    if (result.warnings.length > 0) {
      lines.push(`\nWarnings (${result.warnings.length}):`);
      for (const warn of result.warnings) {
        lines.push(`  • ${warn.path || '(root)'}: ${warn.message}`);
      }
    }

    return lines.join('\n');
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let globalValidator: ConfigValidator | null = null;

export function getValidator(): ConfigValidator {
  if (!globalValidator) {
    globalValidator = new ConfigValidator();
  }
  return globalValidator;
}