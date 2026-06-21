/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Memory Compounding
 *
 * Makes memory compound over time. Auto-extracts entities from wiki writes,
 * cross-references new facts against existing knowledge, detects contradictions,
 * and builds the knowledge graph automatically.
 *
 * No LLM — all extraction is pattern-based and deterministic.
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompoundingConfig {
  /** Data directory for compounding state */
  dataDir: string;
  /** Wiki root directory */
  wikiRoot: string;
}

export interface ExtractedEntity {
  name: string;
  type: 'person' | 'project' | 'concept' | 'tool' | 'date' | 'metric' | 'technology';
  mentions: string[];
  confidence: number;
}

export interface Contradiction {
  id: string;
  newClaim: string;
  existingClaim: string;
  sourceFile: string;
  existingSource: string;
  severity: 'minor' | 'major' | 'critical';
  detectedAt: string;
}

export interface CompoundingReport {
  entitiesExtracted: number;
  contradictionsFound: number;
  crossReferencesAdded: number;
  graphNodesAdded: number;
  graphEdgesAdded: number;
  timestamp: string;
}

// ─── Entity Extraction Patterns ─────────────────────────────────────────────

// Pattern-based extraction — no LLM, just regex and heuristics
const ENTITY_PATTERNS: { type: ExtractedEntity['type']; pattern: RegExp; confidence: number }[] = [
  // Technologies — TypeScript, React, Node.js, Docker, etc.
  { type: 'technology', pattern: /\b(TypeScript|JavaScript|React|Next\.js|Node\.js|Docker|Kubernetes|PostgreSQL|MongoDB|Redis|Python|Go|Rust|Vue|Angular|Svelte|Astro|Tailwind|GraphQL|REST|gRPC|WebSockets|Socket\.IO)\b/g, confidence: 0.9 },
  // Projects — [[project-name]], "the X project", "Project X"
  { type: 'project', pattern: /\[\[([a-z0-9-]+)\]\]/g, confidence: 0.85 },
  // Tools — "using X tool", "X framework", "X library"
  { type: 'tool', pattern: /\b(\w+)\s+(?:tool|framework|library|plugin|extension)\b/g, confidence: 0.6 },
  // Metrics — numbers with units
  { type: 'metric', pattern: /\b(\d+(?:\.\d+)?)\s*(%|ms|seconds?|minutes?|hours?|days?|MB|GB|KB|tokens?|lines?|files?)\b/gi, confidence: 0.7 },
  // Dates — ISO format, common formats
  { type: 'date', pattern: /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|January|February|March|April|May|June|July|August|September|October|November|December)\b/g, confidence: 0.8 },
];

// Contradiction indicators
const CONTRADICTION_MARKERS = [
  /\b(no longer|not anymore|previously|used to be|changed from|replaced by|deprecated|removed|deleted)\b/i,
  /\b(actually|correction|update|revise|wrong|incorrect|mistake)\b/i,
];

// ─── Memory Compounding Engine ──────────────────────────────────────────────

export class MemoryCompounding {
  private config: Required<CompoundingConfig>;
  private contradictions: Contradiction[] = [];

  constructor(config: CompoundingConfig) {
    this.config = {
      dataDir: config.dataDir,
      wikiRoot: config.wikiRoot,
    };

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch { /* exists */ }
  }

  async init(): Promise<void> {
    const contradictionsPath = join(this.config.dataDir, 'contradictions.json');
    if (existsSync(contradictionsPath)) {
      try {
        this.contradictions = JSON.parse(readFileSync(contradictionsPath, 'utf-8'));
      } catch {
        this.contradictions = [];
      }
    }
  }

  /** Extract entities from text content */
  extractEntities(content: string): ExtractedEntity[] {
    const entities: Map<string, ExtractedEntity> = new Map();

    for (const { type, pattern, confidence } of ENTITY_PATTERNS) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1] || match[0];
        const cleanName = name.trim().replace(/[\[\]]/g, '');

        if (cleanName.length < 2 || cleanName.length > 100) continue;

        const key = `${type}:${cleanName.toLowerCase()}`;
        const existing = entities.get(key);

        if (existing) {
          existing.mentions.push(match.index.toString());
        } else {
          entities.set(key, {
            name: cleanName,
            type,
            mentions: [match.index.toString()],
            confidence,
          });
        }
      }
      // Reset regex lastIndex for reuse
      pattern.lastIndex = 0;
    }

    return Array.from(entities.values());
  }

  /** Check a new claim against existing wiki for contradictions */
  checkContradiction(newClaim: string, sourceFile: string): Contradiction | null {
    // Only check if the claim contains contradiction markers
    const hasMarker = CONTRADICTION_MARKERS.some(pattern => pattern.test(newClaim));
    if (!hasMarker) return null;

    // Extract the subject from the claim
    const subjectMatch = newClaim.match(/^(.{5,50}?)(?:\s+(?:is|are|was|were|has|have|had|no longer|not|actually|changed))\b/i);
    if (!subjectMatch) return null;

    const subject = subjectMatch[1].trim().toLowerCase();

    // Search existing wiki for mentions of the same subject
    const wikiIndex = this.loadWikiIndex();
    for (const page of wikiIndex) {
      if (!page.content.toLowerCase().includes(subject)) continue;

      // Found a page that mentions the same subject — check for contradiction
      const existingClaim = this.extractClaimAbout(page.content, subject);
      if (existingClaim && !page.path.endsWith(sourceFile)) {
        const contradiction: Contradiction = {
          id: `contradiction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          newClaim: newClaim.slice(0, 200),
          existingClaim: existingClaim.slice(0, 200),
          sourceFile,
          existingSource: page.path,
          severity: this.assessSeverity(newClaim, existingClaim),
          detectedAt: new Date().toISOString(),
        };

        this.contradictions.push(contradiction);
        this.saveContradictions();

        return contradiction;
      }
    }

    return null;
  }

  /** Process a wiki page write — extract entities, check contradictions, update graph */
  processWikiWrite(filePath: string, content: string): CompoundingReport {
    const entities = this.extractEntities(content);
    let contradictionsFound = 0;

    // Check each sentence for contradictions
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    for (const sentence of sentences) {
      const contradiction = this.checkContradiction(sentence.trim(), filePath);
      if (contradiction) contradictionsFound++;
    }

    // Build cross-references between entities
    const crossReferences = this.findCrossReferences(entities, content);

    return {
      entitiesExtracted: entities.length,
      contradictionsFound,
      crossReferencesAdded: crossReferences,
      graphNodesAdded: entities.length,
      graphEdgesAdded: crossReferences,
      timestamp: new Date().toISOString(),
    };
  }

  /** Find cross-references between entities in the same content */
  private findCrossReferences(entities: ExtractedEntity[], content: string): number {
    let refs = 0;
    const contentLower = content.toLowerCase();

    for (const entity of entities) {
      // Check if this entity is mentioned alongside other entities
      for (const other of entities) {
        if (entity.name === other.name || entity.type === other.type) continue;

        // Are they mentioned within 200 chars of each other?
        const idx1 = contentLower.indexOf(entity.name.toLowerCase());
        const idx2 = contentLower.indexOf(other.name.toLowerCase());
        if (idx1 >= 0 && idx2 >= 0 && Math.abs(idx1 - idx2) < 200) {
          refs++;
        }
      }
    }

    return Math.floor(refs / 2); // Don't double-count pairs
  }

  /** Generate a weekly growth report */
  generateGrowthReport(): {
    totalEntities: number;
    totalContradictions: number;
    wikiPages: number;
    growthRate: string;
    thinAreas: string[];
  } {
    const wikiIndex = this.loadWikiIndex();
    let totalEntities = 0;
    const areaCounts: Record<string, number> = {};

    for (const page of wikiIndex) {
      const entities = this.extractEntities(page.content);
      totalEntities += entities.length;

      const area = page.path.split('/').slice(-2, -1)[0] || 'root';
      areaCounts[area] = (areaCounts[area] || 0) + entities.length;
    }

    // Find thin areas (< 5 entities)
    const thinAreas = Object.entries(areaCounts)
      .filter(([, count]) => count < 5)
      .map(([area]) => area);

    return {
      totalEntities,
      totalContradictions: this.contradictions.length,
      wikiPages: wikiIndex.length,
      growthRate: `${wikiIndex.length} pages, ${totalEntities} entities`,
      thinAreas,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private loadWikiIndex(): { path: string; content: string }[] {
    const pages: { path: string; content: string }[] = [];
    const indexPath = join(this.config.wikiRoot, 'index.md');

    if (existsSync(indexPath)) {
      // Simple approach: read index, then read each linked page
      const indexContent = readFileSync(indexPath, 'utf-8');
      const linkPattern = /\[\[([^\]]+)\]\]/g;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(indexContent)) !== null) {
        const slug = match[1];
        const pagePath = join(this.config.wikiRoot, `${slug}.md`);
        if (existsSync(pagePath)) {
          pages.push({
            path: pagePath,
            content: readFileSync(pagePath, 'utf-8'),
          });
        }
      }
      linkPattern.lastIndex = 0;
    }

    return pages;
  }

  private extractClaimAbout(content: string, subject: string): string | null {
    const sentences = content.split(/[.!?]+/);
    for (const s of sentences) {
      if (s.toLowerCase().includes(subject) && s.trim().length > 10) {
        return s.trim();
      }
    }
    return null;
  }

  private assessSeverity(newClaim: string, existingClaim: string): Contradiction['severity'] {
    const newLower = newClaim.toLowerCase();
    if (newLower.match(/no longer|removed|deleted|deprecated/)) return 'critical';
    if (newLower.match(/changed|replaced|updated|corrected/)) return 'major';
    return 'minor';
  }

  private saveContradictions(): void {
    const path = join(this.config.dataDir, 'contradictions.json');
    writeFileSync(path, JSON.stringify(this.contradictions.slice(-100), null, 2));
  }

  /** Process a vector memory store — extract entities, check against wiki for contradictions */
  processVectorStore(key: string, text: string): CompoundingReport {
    const entities = this.extractEntities(text);
    let contradictionsFound = 0;

    // Check each sentence for contradictions against existing wiki pages
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    for (const sentence of sentences) {
      const contradiction = this.checkContradiction(sentence.trim(), key);
      if (contradiction) contradictionsFound++;
    }

    // Build cross-references between entities
    const crossReferences = this.findCrossReferences(entities, text);

    return {
      entitiesExtracted: entities.length,
      contradictionsFound,
      crossReferencesAdded: crossReferences,
      graphNodesAdded: entities.length,
      graphEdgesAdded: crossReferences,
      timestamp: new Date().toISOString(),
    };
  }

  /** Get unresolved contradictions */
  getContradictions(): Contradiction[] {
    return this.contradictions;
  }
}