/**
 * Lodestone — Evidence-Gated Memory Promotion
 *
 * Before a scratch buffer entry or vector memory gets promoted to the
 * wiki (permanent knowledge), it must pass verification. This protects
 * knowledge quality — the wiki is a compounding asset, and garbage in
 * compounds into garbage out.
 *
 * Inspired by Argus's evidence-gated approach, adapted for Lodestone's
 * wiki + scratch buffer architecture:
 *
 * 1. Verify: Cross-reference the claim against existing wiki pages
 * 2. Check: Run deterministic verification (no LLM needed)
 * 3. Flag: Mark contradictions for human review
 * 4. Promote: Only verified claims get wiki pages
 *
 * Verification levels:
 * - UNVERIFIED: Raw scratch, no checks
 * - CROSS_REFERENCED: Checked against existing wiki for conflicts
 * - EVIDENCE_GATED: Verified against sources, no contradictions
 * - CANONICAL: Human-reviewed and confirmed
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerificationLevel = 'unverified' | 'cross-referenced' | 'evidence-gated' | 'canonical';

export interface MemoryCandidate {
  /** The claim or fact to promote */
  claim: string;
  /** Source of the claim (scratch key, vector ID, etc.) */
  source: string;
  /** Category for the wiki page */
  category: 'entities' | 'concepts' | 'decisions' | 'projects' | 'areas' | 'research';
  /** Tags */
  tags: string[];
  /** When this candidate was created */
  createdAt: string;
  /** Current verification level */
  verificationLevel: VerificationLevel;
  /** Verification details */
  verification: VerificationResult;
}

export interface VerificationResult {
  /** Whether the claim passed verification */
  passed: boolean;
  /** Verification level achieved */
  level: VerificationLevel;
  /** Conflicts found with existing wiki */
  conflicts: ConflictEntry[];
  /** Supporting evidence found */
  supportingEvidence: string[];
  /** Warnings */
  warnings: string[];
  /** Timestamp */
  verifiedAt: string;
}

export interface ConflictEntry {
  /** Wiki page slug that conflicts */
  slug: string;
  /** The conflicting content */
  conflictingContent: string;
  /** What the conflict is about */
  description: string;
  /** Severity: low, medium, high */
  severity: 'low' | 'medium' | 'high';
}

export interface MemoryPromotionConfig {
  /** Directory for storing promotion queue */
  dataDir: string;
  /** Minimum verification level required for auto-promotion */
  autoPromotionLevel?: VerificationLevel;
  /** Maximum candidates in the queue */
  maxQueueSize?: number;
}

// ─── Deterministic Verification Checks ──────────────────────────────────────

/**
 * These checks run WITHOUT an LLM. They're pure logic — pattern matching,
 * cross-referencing, consistency checks. This is the "truth-binding" layer.
 */
const DETERMINISTIC_CHECKS: Array<{
  name: string;
  check: (claim: string, existingContent: Map<string, string>) => ConflictEntry[];
}> = [
  {
    name: 'temporal-consistency',
    check: (claim, existingContent) => {
      const conflicts: ConflictEntry[] = [];
      // Check for contradictory temporal claims ("X is Y" vs "X was Y")
      const presentTensePattern = /\b(is|has|does|runs|lives)\b/i;
      const pastTensePattern = /\b(was|had|did|ran|lived)\b/i;

      for (const [slug, content] of existingContent) {
        // If the claim says something IS and wiki says it WAS, flag it
        if (presentTensePattern.test(claim)) {
          const claimSubject = claim.split(/\s+(is|has|does|runs|lives)\s+/i)[0]?.trim();
          if (claimSubject && content.includes(claimSubject)) {
            const wikiLines = content.split('\n').filter(l => l.includes(claimSubject));
            for (const line of wikiLines) {
              if (pastTensePattern.test(line) && !presentTensePattern.test(line)) {
                conflicts.push({
                  slug,
                  conflictingContent: line.trim(),
                  description: `Claim says "${claimSubject} IS" but wiki says "${line.trim()}"`,
                  severity: 'medium',
                });
              }
            }
          }
        }
      }
      return conflicts;
    },
  },
  {
    name: 'duplicate-claim',
    check: (claim, existingContent) => {
      const conflicts: ConflictEntry[] = [];
      const claimWords = claim.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      if (claimWords.length < 3) return conflicts;

      for (const [slug, content] of existingContent) {
        const contentLower = content.toLowerCase();
        const matchCount = claimWords.filter(w => contentLower.includes(w)).length;
        const matchRatio = matchCount / claimWords.length;

        // If more than 70% of significant words appear in existing content, it might be a duplicate
        if (matchRatio > 0.7) {
          conflicts.push({
            slug,
            conflictingContent: content.slice(0, 200),
            description: `Claim appears similar to existing content in [[${slug}]] (${(matchRatio * 100).toFixed(0)}% word overlap)`,
            severity: matchRatio > 0.9 ? 'high' : 'low',
          });
        }
      }
      return conflicts;
    },
  },
  {
    name: 'url-verification',
    check: (claim) => {
      const conflicts: ConflictEntry[] = [];
      // Extract URLs from the claim and check format
      const urlPattern = /https?:\/\/[^\s)}\]]+/g;
      const urls = claim.match(urlPattern) || [];

      for (const url of urls) {
        // Check for obviously invalid URLs
        if (url.includes('example.com') || url.includes('localhost') || url.includes('127.0.0.1')) {
          conflicts.push({
            slug: '__url_check__',
            conflictingContent: url,
            description: `URL appears to be a placeholder or local address: ${url}`,
            severity: 'low',
          });
        }
      }
      return conflicts;
    },
  },
  {
    name: 'secret-detection',
    check: (claim) => {
      const conflicts: ConflictEntry[] = [];
      // Check for potential secrets/credentials
      const secretPatterns = [
        /sk-[a-zA-Z0-9]{20,}/,  // OpenAI keys
        /ghp_[a-zA-Z0-9]{36}/,  // GitHub PATs
        /AKIA[A-Z0-9]{16}/,     // AWS keys
        /[a-f0-9]{32,}/,         // Generic hex (could be API keys)
        /password\s*[:=]\s*\S+/i, // Password assignments
        /token\s*[:=]\s*\S+/i,    // Token assignments
      ];

      for (const pattern of secretPatterns) {
        if (pattern.test(claim)) {
          conflicts.push({
            slug: '__secret_check__',
            conflictingContent: '[REDACTED]',
            description: 'Potential secret or credential detected in claim — must be redacted before promotion',
            severity: 'high',
          });
          break;
        }
      }
      return conflicts;
    },
  },
];

// ─── Memory Promotion System ─────────────────────────────────────────────────

export class MemoryPromotion {
  private queue: Map<string, MemoryCandidate> = new Map();
  private config: MemoryPromotionConfig;
  private filePath: string;
  private wikiContent: Map<string, string> = new Map();
  private loaded = false;
  private logger = getLogger('MemoryPromotion');

  constructor(config: MemoryPromotionConfig) {
    this.config = config;
    this.filePath = join(config.dataDir, 'promotion-queue.json');
  }

  /** Initialize by loading existing queue */
  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      for (const candidate of parsed) {
        this.queue.set(candidate.claim, candidate);
      }
      this.logger.info('Loaded memory promotion candidates', { count: this.queue.size });
    } catch {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      await this.save();
    }
    this.loaded = true;
  }

  /**
   * Load wiki content for cross-referencing.
   * Call this after wiki initialization.
   */
  loadWikiContent(wikiPages: Array<{ slug: string; content: string }>): void {
    this.wikiContent.clear();
    for (const page of wikiPages) {
      this.wikiContent.set(page.slug, page.content);
    }
  }

  /**
   * Submit a memory candidate for promotion.
   * Runs deterministic verification immediately.
   */
  async submit(claim: string, source: string, category: MemoryCandidate['category'], tags: string[]): Promise<MemoryCandidate> {
    // Run deterministic verification
    const verification = this.verify(claim);

    const candidate: MemoryCandidate = {
      claim,
      source,
      category,
      tags,
      createdAt: new Date().toISOString(),
      verificationLevel: verification.passed ? verification.level : 'unverified',
      verification,
    };

    this.queue.set(claim, candidate);
    this.evictIfNeeded();
    await this.save();

    return candidate;
  }

  /**
   * Run deterministic verification on a claim.
   * No LLM in the policy path — purely rule-based.
   */
  verify(claim: string): VerificationResult {
    const conflicts: ConflictEntry[] = [];
    const warnings: string[] = [];
    const supportingEvidence: string[] = [];

    // Run all deterministic checks
    for (const check of DETERMINISTIC_CHECKS) {
      const checkConflicts = check.check(claim, this.wikiContent);
      conflicts.push(...checkConflicts);
    }

    // Check claim length and quality
    if (claim.length < 10) {
      warnings.push('Claim is very short — may not be meaningful enough for a wiki page');
    }
    if (claim.length > 500) {
      warnings.push('Claim is very long — consider breaking into smaller facts');
    }

    // Determine verification level
    const highSeverityConflicts = conflicts.filter(c => c.severity === 'high');
    const mediumSeverityConflicts = conflicts.filter(c => c.severity === 'medium');

    let level: VerificationLevel;
    let passed: boolean;

    if (highSeverityConflicts.length > 0) {
      // High severity conflicts block promotion
      level = 'unverified';
      passed = false;
      warnings.push(`${highSeverityConflicts.length} high-severity conflict(s) must be resolved before promotion`);
    } else if (mediumSeverityConflicts.length > 0) {
      // Medium severity — cross-referenced but needs review
      level = 'cross-referenced';
      passed = true;
      warnings.push(`${mediumSeverityConflicts.length} medium-severity conflict(s) flagged for review`);
    } else if (conflicts.filter(c => c.severity === 'low').length > 0) {
      // Only low severity — good to go with note
      level = 'cross-referenced';
      passed = true;
    } else {
      // No conflicts at all
      level = 'evidence-gated';
      passed = true;

      // Check for supporting evidence in wiki
      for (const [slug, content] of this.wikiContent) {
        const claimWords = claim.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const matchCount = claimWords.filter(w => content.toLowerCase().includes(w)).length;
        if (matchCount > claimWords.length * 0.3) {
          supportingEvidence.push(`[[${slug}]] — related content`);
        }
      }
    }

    return {
      passed,
      level,
      conflicts,
      supportingEvidence,
      warnings,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Re-verify a candidate (e.g., after wiki content changes).
   */
  async reverify(claim: string): Promise<MemoryCandidate | null> {
    const candidate = this.queue.get(claim);
    if (!candidate) return null;

    const verification = this.verify(claim);
    candidate.verification = verification;
    candidate.verificationLevel = verification.passed ? verification.level : 'unverified';

    await this.save();
    return candidate;
  }

  /**
   * Promote a candidate to canonical (human-confirmed).
   */
  async promoteToCanonical(claim: string): Promise<MemoryCandidate | null> {
    const candidate = this.queue.get(claim);
    if (!candidate) return null;

    candidate.verificationLevel = 'canonical';
    candidate.verification.passed = true;
    candidate.verification.level = 'canonical';
    candidate.verification.verifiedAt = new Date().toISOString();

    await this.save();
    return candidate;
  }

  /**
   * Get candidates ready for auto-promotion.
   * Only returns candidates that meet the minimum verification level.
   */
  getReadyForPromotion(): MemoryCandidate[] {
    const minLevel = this.config.autoPromotionLevel || 'evidence-gated';
    const levelOrder: VerificationLevel[] = ['unverified', 'cross-referenced', 'evidence-gated', 'canonical'];
    const minIndex = levelOrder.indexOf(minLevel);

    return Array.from(this.queue.values())
      .filter(c => {
        const candidateLevel = levelOrder.indexOf(c.verificationLevel);
        return candidateLevel >= minIndex && c.verification.passed;
      })
      .sort((a, b) => levelOrder.indexOf(b.verificationLevel) - levelOrder.indexOf(a.verificationLevel));
  }

  /**
   * Get candidates with conflicts that need human review.
   */
  getNeedsReview(): MemoryCandidate[] {
    return Array.from(this.queue.values())
      .filter(c => c.verification.conflicts.some(conflict => conflict.severity === 'medium' || conflict.severity === 'high'))
      .sort((a, b) => {
        const aMax = Math.max(...a.verification.conflicts.map(c => c.severity === 'high' ? 3 : c.severity === 'medium' ? 2 : 1));
        const bMax = Math.max(...b.verification.conflicts.map(c => c.severity === 'high' ? 3 : c.severity === 'medium' ? 2 : 1));
        return bMax - aMax;
      });
  }

  /**
   * Remove a candidate from the queue.
   */
  async remove(claim: string): Promise<boolean> {
    const deleted = this.queue.delete(claim);
    if (deleted) await this.save();
    return deleted;
  }

  /** Get all candidates */
  listQueue(): MemoryCandidate[] {
    return Array.from(this.queue.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Get statistics */
  getStats(): { total: number; byLevel: Record<VerificationLevel, number>; needsReview: number } {
    const candidates = Array.from(this.queue.values());
    const byLevel: Record<VerificationLevel, number> = {
      unverified: 0,
      'cross-referenced': 0,
      'evidence-gated': 0,
      canonical: 0,
    };
    for (const c of candidates) {
      byLevel[c.verificationLevel]++;
    }
    return {
      total: candidates.length,
      byLevel,
      needsReview: candidates.filter(c => c.verification.conflicts.some(conflict => conflict.severity !== 'low')).length,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    const maxSize = this.config.maxQueueSize || 500;
    if (this.queue.size <= maxSize) return;

    // Evict oldest unverified candidates first
    const sorted = Array.from(this.queue.entries())
      .sort(([, a], [, b]) => {
        // Keep canonical and evidence-gated, evict unverified first
        const levelOrder: Record<VerificationLevel, number> = {
          unverified: 0,
          'cross-referenced': 1,
          'evidence-gated': 2,
          canonical: 3,
        };
        const aScore = levelOrder[a.verificationLevel];
        const bScore = levelOrder[b.verificationLevel];
        if (aScore !== bScore) return aScore - bScore;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

    while (this.queue.size > maxSize) {
      const [key] = sorted.shift()!;
      this.queue.delete(key);
    }
  }

  private async save(): Promise<void> {
    const data = Array.from(this.queue.values());
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}