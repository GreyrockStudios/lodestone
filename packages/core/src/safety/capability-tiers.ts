/**
 * Lodestone — Capability Tiers
 *
 * Every tool has a risk level. Before executing a privileged tool,
 * the agent simulates consequences and requires explicit confirmation.
 * This is inspired by WASP's capability tiers, adapted for Lodestone.
 *
 * Tiers:
 * - PUBLIC: Read-only, no side effects. Always safe.
 * - CONTROLLED: Minor side effects (memory writes, wiki edits). Auto-approved.
 * - RESTRICTED: Significant side effects (file writes, API calls). Needs confirmation.
 * - PRIVILEGED: Destructive or irreversible (file deletion, external sends, code execution).
 *   Requires confirmation AND anticipatory simulation.
 */

export type CapabilityTier = 'public' | 'controlled' | 'restricted' | 'privileged';

export interface TierConfig {
  /** The tool's capability tier */
  tier: CapabilityTier;
  /** Human-readable description of what this tier means for this tool */
  description: string;
  /** Whether to require confirmation before execution */
  requiresConfirmation: boolean;
  /** Whether to run anticipatory simulation before execution */
  requiresSimulation: boolean;
  /** Whether this tool can be auto-approved in sleep/heartbeat mode */
  allowedInSleep: boolean;
}

// ─── Default Tier Assignments ────────────────────────────────────────────────

const DEFAULT_TIERS: Record<string, TierConfig> = {
  // Public — read-only, no side effects
  'wiki-resolve':   { tier: 'public',      description: 'Resolve wiki links — read-only',        requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'wiki-search':    { tier: 'public',      description: 'Search wiki — read-only',               requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'smart-retrieve': { tier: 'public',      description: 'Retrieve relevant wiki pages — read-only', requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'prediction-journal': { tier: 'controlled', description: 'Log and resolve predictions',         requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'drift-check':    { tier: 'public',      description: 'Check identity drift — read-only',      requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'rbt-diagnose':   { tier: 'public',      description: 'Self-assessment diagnosis — read-only', requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'skill-learn':    { tier: 'controlled',  description: 'Record lessons and skills',             requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'resume-state':   { tier: 'controlled',  description: 'Save/load session state',                requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'decision-log':   { tier: 'controlled',  description: 'Record decisions',                        requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'watchdog':        { tier: 'controlled',  description: 'Set and check watches',                 requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },
  'business-hours': { tier: 'public',      description: 'Check business hours — read-only',      requiresConfirmation: false, requiresSimulation: false, allowedInSleep: true },

  // Restricted — significant side effects, needs confirmation
  'wiki-write':     { tier: 'restricted',  description: 'Write/update wiki pages — modifies knowledge', requiresConfirmation: true,  requiresSimulation: false, allowedInSleep: false },
  'memory-store':   { tier: 'restricted',  description: 'Store persistent memories',              requiresConfirmation: true,  requiresSimulation: false, allowedInSleep: true },
  'memory-forget':  { tier: 'restricted',  description: 'Delete memories — data removal',         requiresConfirmation: true,  requiresSimulation: false, allowedInSleep: false },
  'file-write':     { tier: 'restricted',  description: 'Write files to disk',                    requiresConfirmation: true,  requiresSimulation: false, allowedInSleep: false },

  // Privileged — destructive/irreversible, requires simulation + confirmation
  'file-delete':    { tier: 'privileged',  description: 'Delete files — irreversible',             requiresConfirmation: true,  requiresSimulation: true,  allowedInSleep: false },
  'exec':           { tier: 'privileged',  description: 'Execute shell commands — arbitrary code', requiresConfirmation: true,  requiresSimulation: true,  allowedInSleep: false },
  'message-send':   { tier: 'privileged',  description: 'Send messages to users — external action', requiresConfirmation: true, requiresSimulation: true,  allowedInSleep: false },
  'cron-add':       { tier: 'privileged',  description: 'Schedule persistent jobs — persistent side effect', requiresConfirmation: true, requiresSimulation: true,  allowedInSleep: false },
  'gateway-restart': { tier: 'privileged',  description: 'Restart the gateway — service disruption', requiresConfirmation: true, requiresSimulation: true, allowedInSleep: false },
};

// ─── Simulation Result ───────────────────────────────────────────────────────

export interface SimulationResult {
  /** Whether the simulation approved the action */
  approved: boolean;
  /** Risk assessment: low, medium, high, critical */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** What the simulation predicts will happen */
  predictedOutcome: string;
  /** Potential side effects identified */
  sideEffects: string[];
  /** Recommendations for the user */
  recommendations: string[];
  /** Whether the action is reversible */
  reversible: boolean;
}

// ─── Capability Manager ──────────────────────────────────────────────────────

export class CapabilityManager {
  private tiers: Map<string, TierConfig> = new Map();

  constructor(customTiers?: Record<string, Partial<TierConfig>>) {
    // Load defaults
    for (const [toolId, config] of Object.entries(DEFAULT_TIERS)) {
      this.tiers.set(toolId, config);
    }
    // Apply custom overrides
    if (customTiers) {
      for (const [toolId, override] of Object.entries(customTiers)) {
        const existing = this.tiers.get(toolId);
        if (existing) {
          this.tiers.set(toolId, { ...existing, ...override });
        } else {
          this.tiers.set(toolId, {
            tier: override.tier || 'restricted',
            description: override.description || `Custom tool: ${toolId}`,
            requiresConfirmation: override.requiresConfirmation ?? true,
            requiresSimulation: override.requiresSimulation ?? false,
            allowedInSleep: override.allowedInSleep ?? false,
          });
        }
      }
    }
  }

  /** Get the tier config for a tool */
  getTier(toolId: string): TierConfig {
    return this.tiers.get(toolId) || {
      tier: 'restricted' as CapabilityTier,
      description: `Unknown tool: ${toolId}`,
      requiresConfirmation: true,
      requiresSimulation: false,
      allowedInSleep: false,
    };
  }

  /** Check if a tool can be auto-approved */
  canAutoApprove(toolId: string): boolean {
    const config = this.getTier(toolId);
    return !config.requiresConfirmation;
  }

  /** Check if a tool can run in sleep/heartbeat mode */
  canRunInSleep(toolId: string): boolean {
    return this.getTier(toolId).allowedInSleep;
  }

  /** Check if a tool requires anticipatory simulation */
  requiresSimulation(toolId: string): boolean {
    return this.getTier(toolId).requiresSimulation;
  }

  /** Get all tools at a given tier */
  getToolsByTier(tier: CapabilityTier): string[] {
    const result: string[] = [];
    for (const [toolId, config] of this.tiers.entries()) {
      if (config.tier === tier) result.push(toolId);
    }
    return result;
  }

  /** Get a summary of all tiers for display */
  getTierSummary(): Record<CapabilityTier, { tools: string[]; count: number }> {
    const summary: Record<CapabilityTier, { tools: string[]; count: number }> = {
      public: { tools: [], count: 0 },
      controlled: { tools: [], count: 0 },
      restricted: { tools: [], count: 0 },
      privileged: { tools: [], count: 0 },
    };
    for (const [toolId, config] of this.tiers.entries()) {
      summary[config.tier].tools.push(toolId);
      summary[config.tier].count++;
    }
    return summary;
  }

  /**
   * Run anticipatory simulation for a privileged tool.
   * This is a rule-based check (no LLM in the policy path, per WASP's approach).
   * Returns a simulation result with risk assessment.
   */
  simulate(toolId: string, params: Record<string, unknown>): SimulationResult {
    const config = this.getTier(toolId);

    if (!config.requiresSimulation) {
      return {
        approved: true,
        riskLevel: 'low',
        predictedOutcome: `Tool ${toolId} does not require simulation`,
        sideEffects: [],
        recommendations: [],
        reversible: true,
      };
    }

    const sideEffects: string[] = [];
    const recommendations: string[] = [];
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    let reversible = true;
    let approved = true;

    // ─── Rule-based simulation ────────────────────────────────────────────

    // Shell/exec checks
    if (toolId === 'exec') {
      const cmd = String(params.command || '');
      const dangerousPatterns = [
        /\brm\s/, /\bdel\s/, /\bdd\s/, /\bmkfs\b/, /\bformat\b/,
        /\bsudo\b/, />\s*\//, /\bsystemctl\s+(stop|restart|disable)\b/,
        /\biptables\b/, /\bchmod\s+777\b/, /\bcurl\s+.*\|\s*bash\b/,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(cmd)) {
          sideEffects.push(`Potentially destructive command detected: matches ${pattern}`);
          riskLevel = 'critical';
          reversible = false;
          approved = false;
        }
      }
      if (cmd.includes('*')) {
        sideEffects.push('Wildcard in command — may affect more files than expected');
        riskLevel = 'high';
        reversible = false;
      }
      recommendations.push('Review the exact command before confirming');
      if (!reversible) {
        recommendations.push('This action is IRREVERSIBLE — proceed with extreme caution');
      }
    }

    // File deletion checks
    if (toolId === 'file-delete' || toolId === 'file-write') {
      const path = String(params.path || '');
      const criticalPaths = ['/etc/', '/usr/', '/System/', '/boot/', '/dev/', 'C:\\Windows'];
      for (const critical of criticalPaths) {
        if (path.startsWith(critical)) {
          sideEffects.push(`Critical system path: ${path}`);
          riskLevel = 'critical';
          reversible = false;
          approved = false;
        }
      }
      if (path.includes('..')) {
        sideEffects.push('Path traversal detected — may escape intended directory');
        riskLevel = 'high';
      }
      recommendations.push('Verify the exact file path before confirming');
    }

    // Message sending checks
    if (toolId === 'message-send') {
      sideEffects.push('External message will be sent — cannot be undone once delivered');
      riskLevel = 'medium';
      reversible = false;
      recommendations.push('Review message content and recipient before confirming');
    }

    // Cron/scheduler checks
    if (toolId === 'cron-add') {
      sideEffects.push('Persistent scheduled job will be created');
      riskLevel = 'medium';
      reversible = true;
      recommendations.push('Verify schedule and payload before confirming');
    }

    // Gateway restart checks
    if (toolId === 'gateway-restart') {
      sideEffects.push('All active sessions will be interrupted');
      sideEffects.push('Services will be temporarily unavailable');
      riskLevel = 'high';
      reversible = true;
      recommendations.push('Consider scheduling during low-activity period');
    }

    return {
      approved,
      riskLevel,
      predictedOutcome: `Executing ${toolId} with ${riskLevel} risk level`,
      sideEffects,
      recommendations,
      reversible,
    };
  }

  /** Register a new tool's tier */
  register(toolId: string, config: Partial<TierConfig>): void {
    this.tiers.set(toolId, {
      tier: config.tier || 'restricted',
      description: config.description || `Tool: ${toolId}`,
      requiresConfirmation: config.requiresConfirmation ?? true,
      requiresSimulation: config.requiresSimulation ?? false,
      allowedInSleep: config.allowedInSleep ?? false,
    });
  }

  /** Override an existing tool's tier */
  override(toolId: string, config: Partial<TierConfig>): void {
    const existing = this.tiers.get(toolId);
    if (existing) {
      this.tiers.set(toolId, { ...existing, ...config });
    }
  }
}