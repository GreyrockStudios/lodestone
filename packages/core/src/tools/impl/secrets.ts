/**
 * Lodestone Tool — Secrets
 *
 * Secure credential storage and retrieval.
 * Uses AES-256-GCM encryption with a key derived from an env var or machine identity.
 * Secrets are stored in an encrypted JSON file at workspaceRoot/data/secrets.enc.json.
 *
 * Security:
 * - Values are masked (***​) in summaries and logs; only included in `data`.
 * - list returns key names only, never values.
 * - set/delete require approval; get/list do not.
 */

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { hostname, userInfo } from 'os';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EncryptedEntry {
  /** Auth tag from GCM */
  tag: string;
  /** Initialization vector */
  iv: string;
  /** Ciphertext */
  ct: string;
}

interface SecretsFile {
  /** Schema version */
  v: number;
  /** Namespace → key → entry */
  namespaces: Record<string, Record<string, EncryptedEntry>>;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class SecretsTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'secrets',
    name: 'Secrets',
    description:
      'Secure credential storage. Store and retrieve encrypted secrets. ' +
      'Actions: get (returns decrypted value in data, masked in summary), ' +
      'set (encrypts and stores), list (returns key names only), delete (removes).',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: get, set, list, or delete',
        required: true,
        enum: ['get', 'set', 'list', 'delete'],
      },
      {
        name: 'key',
        type: 'string',
        description: 'Secret key name',
        required: true,
      },
      {
        name: 'value',
        type: 'string',
        description: 'Secret value (required for set action)',
        required: false,
      },
      {
        name: 'namespace',
        type: 'string',
        description: "Namespace for grouping secrets (default: 'default')",
        required: false,
        default: 'default',
      },
    ],
    sideEffects: true, // set/delete modify state
    requiresApproval: true, // set/delete require approval
    timeout: 5000,
  };

  private keyDerivationSalt = 'lodestone-secrets-v1';
  private keyLen = 32; // 256 bits for AES-256

  // ─── Encryption Key ──────────────────────────────────────────────────────

  private getEncryptionKey(): Buffer {
    const envKey = process.env.LODESTONE_SECRET_KEY;
    if (envKey) {
      // Derive a fixed-length key from the env var
      return scryptSync(envKey, this.keyDerivationSalt, this.keyLen);
    }
    // Machine-specific fallback: hostname + username
    const user = userInfo().username || 'unknown';
    const host = hostname() || 'localhost';
    return scryptSync(`${host}:${user}`, this.keyDerivationSalt, this.keyLen);
  }

  private encrypt(plaintext: string): EncryptedEntry {
    const key = this.getEncryptionKey();
    const iv = randomBytes(12); // 96-bit IV for GCM
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  private decrypt(entry: EncryptedEntry): string {
    const key = this.getEncryptionKey();
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  }

  // ─── File I/O ─────────────────────────────────────────────────────────────

  private getSecretsFilePath(workspaceRoot: string): string {
    return join(workspaceRoot, 'data', 'secrets.enc.json');
  }

  private loadSecrets(filePath: string): SecretsFile {
    if (!existsSync(filePath)) {
      return { v: 1, namespaces: {} };
    }
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SecretsFile;
      if (!parsed.namespaces) parsed.namespaces = {};
      return parsed;
    } catch {
      // Corrupted file — return empty rather than throwing
      return { v: 1, namespaces: {} };
    }
  }

  private saveSecrets(filePath: string, data: SecretsFile): void {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const action = params.action as string;
    const key = params.key as string;
    const namespace = (params.namespace as string) || 'default';
    const filePath = this.getSecretsFilePath(context.workspaceRoot);

    try {
      const secrets = this.loadSecrets(filePath);
      const ns = secrets.namespaces[namespace] || (secrets.namespaces[namespace] = {});

      switch (action) {
        case 'get':
          return this.handleGet(ns, key, namespace, start);

        case 'set': {
          const value = params.value as string | undefined;
          if (value === undefined || value === null) {
            return {
              success: false,
              data: null,
              summary: 'Missing required parameter: value',
              error: 'value is required for set action',
              durationMs: Date.now() - start,
              includeInContext: false,
            };
          }
          ns[key] = this.encrypt(value);
          this.saveSecrets(filePath, secrets);
          return {
            success: true,
            data: { key, namespace },
            summary: `Set secret '${key}' in namespace '${namespace}'`,
            durationMs: Date.now() - start,
            includeInContext: false, // Don't include secret data in context
          };
        }

        case 'list': {
          const keys = Object.keys(ns);
          return {
            success: true,
            data: { namespace, keys },
            summary: `Listed ${keys.length} secrets in namespace '${namespace}'`,
            durationMs: Date.now() - start,
            includeInContext: true,
          };
        }

        case 'delete': {
          if (!(key in ns)) {
            return {
              success: false,
              data: null,
              summary: `Secret '${key}' not found in namespace '${namespace}'`,
              error: 'NotFound',
              durationMs: Date.now() - start,
              includeInContext: false,
            };
          }
          delete ns[key];
          this.saveSecrets(filePath, secrets);
          return {
            success: true,
            data: { key, namespace },
            summary: `Deleted secret '${key}' from namespace '${namespace}'`,
            durationMs: Date.now() - start,
            includeInContext: false,
          };
        }

        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${action}`,
            error: 'Valid actions: get, set, list, delete',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Secrets operation failed: ${err}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private handleGet(
    ns: Record<string, EncryptedEntry>,
    key: string,
    namespace: string,
    start: number,
  ): ToolResult {
    const entry = ns[key];
    if (!entry) {
      return {
        success: false,
        data: null,
        summary: `Secret '${key}' not found in namespace '${namespace}'`,
        error: 'NotFound',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
    const value = this.decrypt(entry);
    return {
      success: true,
      // Value is in data but NOT in summary — summary uses mask
      data: { key, namespace, value },
      summary: `Retrieved secret '***' from namespace '${namespace}'`,
      durationMs: Date.now() - start,
      // Don't auto-include in context — caller decides
      includeInContext: false,
    };
  }
}