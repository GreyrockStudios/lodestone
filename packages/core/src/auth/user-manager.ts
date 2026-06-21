/**
 * Lodestone Core — Multi-User Manager
 *
 * Per-user isolation: identity, permissions, memory namespaces, sessions.
 * Token-based authentication for API access.
 *
 * No external dependencies — pure TypeScript + Node built-ins.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Logger, getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserConfig {
  /** Unique user identifier */
  id: string;
  /** Display name */
  name: string;
  /** Email address (optional) */
  email?: string;
  /** Role: admin, user, or viewer */
  role: 'admin' | 'user' | 'viewer';
  /** Allowed tool IDs and channel IDs */
  permissions: string[];
  /** Isolated memory namespace per user */
  memoryNamespace: string;
  /** Session scope: global = see all sessions, isolated = only own */
  sessionScope: 'global' | 'isolated';
}

// ─── User ────────────────────────────────────────────────────────────────────

/**
 * A registered user. Wraps UserConfig with session tracking.
 */
export class User {
  readonly config: UserConfig;
  /** Active sessions for this user */
  private sessions: Set<string> = new Set();

  constructor(config: UserConfig) {
    this.config = config;
  }

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }
  get role(): string { return this.config.role; }

  /** Check if user has permission for a resource (tool or channel ID) */
  hasPermission(resource: string): boolean {
    // Admins have all permissions
    if (this.config.role === 'admin') return true;
    // Check explicit permissions
    return this.config.permissions.includes(resource);
  }

  /** Add a session to this user's active sessions */
  addSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  /** Remove a session from this user's active sessions */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Get all session IDs for this user */
  getSessionIds(): string[] {
    return Array.from(this.sessions);
  }

  /** Check if a session belongs to this user */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get the memory namespace for this user */
  getMemoryNamespace(): string {
    return this.config.memoryNamespace;
  }
}

// ─── User Manager ────────────────────────────────────────────────────────────

export class UserManager {
  private users: Map<string, User> = new Map();
  private tokens: Map<string, string> = new Map(); // token → userId
  private dataFile: string;
  private logger: Logger | ReturnType<Logger['child']>;

  constructor(dataDir: string) {
    const dir = typeof dataDir === 'string' ? dataDir : './data';
    this.dataFile = join(dir, 'users.json');
    this.logger = getLogger('user-manager') as Logger;

    // Ensure directory exists
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
    } catch { /* exists */ }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Load users from disk */
  async init(): Promise<void> {
    if (!existsSync(this.dataFile)) {
      this.logger.info('No users file found, starting fresh');
      return;
    }

    try {
      const raw = readFileSync(this.dataFile, 'utf-8');
      const data = JSON.parse(raw) as {
        users: UserConfig[];
        tokens: Record<string, string>;
      };

      for (const config of data.users) {
        this.users.set(config.id, new User(config));
      }

      // Load tokens (token → userId)
      for (const [token, userId] of Object.entries(data.tokens)) {
        this.tokens.set(token, userId);
      }

      this.logger.info(`Loaded ${this.users.size} users, ${this.tokens.size} tokens`);
    } catch (err) {
      this.logger.warn(`Failed to load users: ${err}`);
    }
  }

  /** Save users and tokens to disk */
  save(): void {
    const data = {
      users: Array.from(this.users.values()).map(u => u.config),
      tokens: Object.fromEntries(this.tokens),
    };

    try {
      const dir = dirname(this.dataFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error(`Failed to save users: ${err}`);
    }
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Create a new user.
   * @throws if user ID already exists
   */
  createUser(config: UserConfig): User {
    if (this.users.has(config.id)) {
      throw new Error(`User '${config.id}' already exists. Use a unique user ID or call updateUser() instead.`);
    }

    // Validate config
    this.validateConfig(config);

    const user = new User(config);
    this.users.set(config.id, user);
    this.save();
    this.logger.info(`Created user: ${config.name} (${config.id}), role: ${config.role}`);
    return user;
  }

  /**
   * Get a user by ID.
   * @returns User or null if not found
   */
  getUser(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  /**
   * List all registered users.
   */
  listUsers(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * Update a user's configuration.
   * @returns Updated User or null if not found
   */
  updateUser(id: string, patch: Partial<UserConfig>): User | null {
    const user = this.users.get(id);
    if (!user) return null;

    const updated: UserConfig = {
      ...user.config,
      ...patch,
      // Don't allow ID changes
      id: user.config.id,
    };

    this.validateConfig(updated);

    // Replace user object (User is immutable from outside)
    const newUser = new User(updated);
    // Preserve session tracking
    for (const sessionId of user.getSessionIds()) {
      newUser.addSession(sessionId);
    }
    this.users.set(id, newUser);
    this.save();
    this.logger.info(`Updated user: ${id}`);
    return newUser;
  }

  /**
   * Delete a user by ID.
   * @returns true if deleted, false if not found
   */
  deleteUser(id: string): boolean {
    if (!this.users.has(id)) return false;

    // Remove all tokens for this user
    for (const [token, userId] of this.tokens) {
      if (userId === id) {
        this.tokens.delete(token);
      }
    }

    this.users.delete(id);
    this.save();
    this.logger.info(`Deleted user: ${id}`);
    return true;
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  /**
   * Authenticate a user by API token.
   * @returns User if token is valid, null otherwise
   */
  authenticate(token: string): User | null {
    const userId = this.tokens.get(token);
    if (!userId) return null;

    const user = this.users.get(userId);
    if (!user) {
      // Stale token — clean up
      this.tokens.delete(token);
      return null;
    }

    return user;
  }

  /**
   * Assign an API token to a user.
   * @returns The token string
   */
  assignToken(userId: string, token: string): string {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User '${userId}' not found. Use listUsers() to see registered users.`);

    this.tokens.set(token, userId);
    this.save();
    this.logger.info(`Token assigned to user: ${userId}`);
    return token;
  }

  /**
   * Revoke an API token.
   */
  revokeToken(token: string): boolean {
    const existed = this.tokens.delete(token);
    if (existed) {
      this.save();
      this.logger.info('Token revoked');
    }
    return existed;
  }

  /**
   * List all tokens for a user.
   */
  getUserTokens(userId: string): string[] {
    const tokens: string[] = [];
    for (const [token, uid] of this.tokens) {
      if (uid === userId) tokens.push(token);
    }
    return tokens;
  }

  // ─── Permission Checks ──────────────────────────────────────────────────

  /**
   * Check if a user has permission for a resource (tool or channel).
   */
  hasPermission(userId: string, resource: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    return user.hasPermission(resource);
  }

  // ─── Memory Isolation ──────────────────────────────────────────────────

  /**
   * Get the memory namespace for a user.
   * Used for per-user memory isolation in the vector DB and wiki.
   */
  getMemoryNamespace(userId: string): string {
    const user = this.users.get(userId);
    if (!user) return 'default';
    return user.getMemoryNamespace();
  }

  // ─── Session Access ────────────────────────────────────────────────────

  /**
   * Validate whether a user can access a specific session.
   * - Admin users with global scope can access any session.
   * - Users with isolated scope can only access their own sessions.
   * - Users with global scope can access all sessions.
   */
  validateSessionAccess(userId: string, sessionId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    // Admins can access everything
    if (user.config.role === 'admin') return true;

    // Global scope = see all sessions
    if (user.config.sessionScope === 'global') return true;

    // Isolated scope = only own sessions
    return user.ownsSession(sessionId);
  }

  // ─── Introspection ──────────────────────────────────────────────────────

  /** Count of registered users */
  count(): number {
    return this.users.size;
  }

  /** Count of active tokens */
  tokenCount(): number {
    return this.tokens.size;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private validateConfig(config: UserConfig): void {
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('UserConfig.id is required and must be a string');
    }
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('UserConfig.name is required and must be a string');
    }
    if (!['admin', 'user', 'viewer'].includes(config.role)) {
      throw new Error(`UserConfig.role must be 'admin', 'user', or 'viewer' (got: '${config.role}')`);
    }
    if (!Array.isArray(config.permissions)) {
      throw new Error('UserConfig.permissions must be an array');
    }
    if (!config.memoryNamespace || typeof config.memoryNamespace !== 'string') {
      throw new Error('UserConfig.memoryNamespace is required and must be a string');
    }
    if (!['global', 'isolated'].includes(config.sessionScope)) {
      throw new Error(`UserConfig.sessionScope must be 'global' or 'isolated' (got: '${config.sessionScope}')`);
    }
  }
}