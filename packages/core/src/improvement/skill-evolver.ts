/**
 * Lodestone — Skill Evolver
 *
 * Learn from experience. Extract durable rules from trial-and-error.
 * Promote well-tested patterns to core instructions.
 *
 * Inspired by SkillOpt-Sleep (Microsoft Research 2026):
 * agents that extract and validate skills from experience
 * compound their capabilities over time.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Lesson {
  /** Unique lesson ID */
  id: string;
  /** The lesson learned (one clear sentence) */
  lesson: string;
  /** Context where this lesson was learned */
  context: string;
  /** Category: coding, communication, decision-making, safety, quality, etc. */
  category: string;
  /** How this was learned: trial-and-error, observation, feedback, reflection */
  source: 'trial-and-error' | 'observation' | 'feedback' | 'reflection';
  /** Confidence in this lesson (0-1) */
  confidence: number;
  /** Number of times this lesson has been validated */
  validations: number;
  /** Number of times this lesson has been contradicted */
  contradictions: number;
  /** Whether this lesson has been promoted to core instructions */
  promoted: boolean;
  /** When this lesson was first learned */
  createdAt: string;
  /** When this lesson was last validated */
  updatedAt: string;
  /** Tags for grouping */
  tags?: string[];
}

export interface Skill {
  /** The promoted skill name */
  name: string;
  /** The full skill instruction */
  instruction: string;
  /** Original lesson IDs that were merged */
  sourceLessons: string[];
  /** When this skill was promoted */
  promotedAt: string;
  /** Category */
  category: string;
}

export interface EvolveResult {
  /** Patterns found across lessons */
  patterns: {
    /** Groups of lessons that share a common theme */
    theme: string;
    /** Lesson IDs in this group */
    lessons: string[];
    /** Suggested skill instruction */
    suggestedInstruction: string;
    /** Whether this pattern has enough evidence to promote */
    ready: boolean;
  }[];
  /** Lessons ready for promotion */
  readyForPromotion: string[];
  /** Contradicted lessons that should be reviewed */
  contradicted: string[];
  /** New patterns discovered */
  newPatterns: number;
}

// ─── Skill Evolver ──────────────────────────────────────────────────────────

export class SkillEvolver {
  private lessons: Map<string, Lesson> = new Map();
  private skills: Map<string, Skill> = new Map();
  private lessonsDir: string;
  private skillsDir: string;
  private loaded = false;

  constructor(dataDir: string) {
    this.lessonsDir = join(dataDir, 'skills', 'lessons');
    this.skillsDir = join(dataDir, 'skills', 'promoted');
  }

  /** Load lessons and skills from disk */
  async init(): Promise<void> {
    if (this.loaded) return;

    // Load lessons
    if (existsSync(this.lessonsDir)) {
      const files = await readdir(this.lessonsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await readFile(join(this.lessonsDir, file), 'utf-8');
          const lesson: Lesson = JSON.parse(data);
          this.lessons.set(lesson.id, lesson);
        } catch {
          // Skip malformed files
        }
      }
    }

    // Load promoted skills
    if (existsSync(this.skillsDir)) {
      const files = await readdir(this.skillsDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = await readFile(join(this.skillsDir, file), 'utf-8');
          const skill = this.parseSkillMarkdown(content);
          if (skill) this.skills.set(skill.name, skill);
        } catch {
          // Skip malformed files
        }
      }
    }

    this.loaded = true;
  }

  // ─── Core Operations ────────────────────────────────────────────────

  /** Record a lesson from experience */
  async learnLesson(
    lesson: string,
    context: string,
    category: string,
    source: Lesson['source'] = 'reflection',
    tags?: string[],
  ): Promise<Lesson> {
    await this.ensureInit();

    const id = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: Lesson = {
      id,
      lesson,
      context,
      category,
      source,
      confidence: 0.5, // Start at 50% — unvalidated
      validations: 0,
      contradictions: 0,
      promoted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags,
    };

    this.lessons.set(id, entry);
    await this.persistLesson(entry);
    return entry;
  }

  /** Validate a lesson — increase confidence */
  async validate(lessonId: string, evidence?: string): Promise<Lesson> {
    await this.ensureInit();

    const lesson = this.lessons.get(lessonId);
    if (!lesson) {
      throw new Error(`Lesson ${lessonId} not found`);
    }

    lesson.validations++;
    lesson.confidence = Math.min(1, lesson.confidence + 0.1);
    lesson.updatedAt = new Date().toISOString();

    await this.persistLesson(lesson);
    return lesson;
  }

  /** Contradict a lesson — decrease confidence */
  async contradict(lessonId: string, evidence?: string): Promise<Lesson> {
    await this.ensureInit();

    const lesson = this.lessons.get(lessonId);
    if (!lesson) {
      throw new Error(`Lesson ${lessonId} not found`);
    }

    lesson.contradictions++;
    lesson.confidence = Math.max(0, lesson.confidence - 0.15);
    lesson.updatedAt = new Date().toISOString();

    await this.persistLesson(lesson);
    return lesson;
  }

  /** Promote a learned skill to core instructions */
  async promote(skillName: string, instruction?: string): Promise<Skill> {
    await this.ensureInit();

    // Find the lesson(s) that match this skill name
    const matchingLessons = Array.from(this.lessons.values())
      .filter(l => !l.promoted && (
        l.lesson.toLowerCase().includes(skillName.toLowerCase()) ||
        l.category.toLowerCase() === skillName.toLowerCase() ||
        l.tags?.some(t => t.toLowerCase() === skillName.toLowerCase())
      ));

    if (matchingLessons.length === 0) {
      throw new Error(`No lessons found matching "${skillName}"`);
    }

    // Mark lessons as promoted
    const sourceIds: string[] = [];
    for (const lesson of matchingLessons) {
      lesson.promoted = true;
      lesson.updatedAt = new Date().toISOString();
      await this.persistLesson(lesson);
      sourceIds.push(lesson.id);
    }

    // Generate skill instruction
    const skillInstruction = instruction || this.synthesizeInstruction(matchingLessons);

    const category = matchingLessons[0].category;

    const skill: Skill = {
      name: skillName,
      instruction: skillInstruction,
      sourceLessons: sourceIds,
      promotedAt: new Date().toISOString(),
      category,
    };

    this.skills.set(skillName, skill);
    await this.persistSkill(skill);
    return skill;
  }

  /**
   * Review all lessons, find patterns, and suggest promotions.
   * The evolve cycle: group similar lessons, identify patterns,
   * check validation scores, recommend promotions.
   */
  async evolve(): Promise<EvolveResult> {
    await this.ensureInit();

    const allLessons = Array.from(this.lessons.values());
    const unpromoted = allLessons.filter(l => !l.promoted);

    // Group lessons by category
    const categoryGroups = new Map<string, Lesson[]>();
    for (const lesson of unpromoted) {
      const cat = lesson.category;
      if (!categoryGroups.has(cat)) categoryGroups.set(cat, []);
      categoryGroups.get(cat)!.push(lesson);
    }

    const patterns: EvolveResult['patterns'] = [];

    for (const [category, lessons] of categoryGroups) {
      // Further group by keyword similarity within category
      const subGroups = this.clusterBySimilarity(lessons);

      for (const group of subGroups) {
        if (group.length < 2) continue; // Need at least 2 lessons for a pattern

        const theme = this.extractTheme(group);
        const avgConfidence = group.reduce((s, l) => s + l.confidence, 0) / group.length;
        const totalValidations = group.reduce((s, l) => s + l.validations, 0);
        const totalContradictions = group.reduce((s, l) => s + l.contradictions, 0);

        patterns.push({
          theme,
          lessons: group.map(l => l.id),
          suggestedInstruction: this.synthesizeInstruction(group),
          ready: avgConfidence >= 0.7 && totalValidations >= 2 && totalContradictions < totalValidations,
        });
      }
    }

    // Find lessons ready for solo promotion
    const readyForPromotion = unpromoted
      .filter(l => l.confidence >= 0.8 && l.validations >= 3 && l.contradictions === 0)
      .map(l => l.id);

    // Find contradicted lessons
    const contradicted = allLessons
      .filter(l => l.contradictions > l.validations)
      .map(l => l.id);

    return {
      patterns,
      readyForPromotion,
      contradicted,
      newPatterns: patterns.filter(p => p.ready).length,
    };
  }

  // ─── Query ──────────────────────────────────────────────────────────

  /** Get a specific lesson */
  async getLesson(lessonId: string): Promise<Lesson | null> {
    await this.ensureInit();
    return this.lessons.get(lessonId) ?? null;
  }

  /** List lessons, optionally filtered */
  async listLessons(options?: {
    category?: string;
    promoted?: boolean;
    minConfidence?: number;
    limit?: number;
  }): Promise<Lesson[]> {
    await this.ensureInit();

    let entries = Array.from(this.lessons.values());

    if (options?.category) {
      entries = entries.filter(l => l.category === options.category);
    }
    if (options?.promoted !== undefined) {
      entries = entries.filter(l => l.promoted === options.promoted);
    }
    if (options?.minConfidence !== undefined) {
      entries = entries.filter(l => l.confidence >= options.minConfidence!);
    }

    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return options?.limit ? entries.slice(0, options.limit) : entries;
  }

  /** List promoted skills */
  async listSkills(): Promise<Skill[]> {
    await this.ensureInit();
    return Array.from(this.skills.values());
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (!this.loaded) {
      await this.init();
    }
  }

  /**
   * Cluster lessons by keyword similarity.
   * Simple greedy clustering: group lessons that share significant keywords.
   */
  private clusterBySimilarity(lessons: Lesson[]): Lesson[][] {
    const clusters: Lesson[][] = [];
    const assigned = new Set<string>();

    for (const lesson of lessons) {
      if (assigned.has(lesson.id)) continue;

      const keywords = this.extractKeywords(lesson.lesson);
      const cluster: Lesson[] = [lesson];
      assigned.add(lesson.id);

      for (const other of lessons) {
        if (assigned.has(other.id)) continue;
        const otherKeywords = this.extractKeywords(other.lesson);
        const overlap = this.setOverlap(keywords, otherKeywords);

        if (overlap >= 0.4) {
          cluster.push(other);
          assigned.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be',
      'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'and', 'but', 'or', 'not', 'this',
      'that', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your']);

    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w)),
    );
  }

  private setOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const word of a) {
      if (b.has(word)) overlap++;
    }
    return overlap / Math.min(a.size, b.size);
  }

  private extractTheme(lessons: Lesson[]): string {
    // Take the most common category and key nouns from lessons
    const allWords = lessons.flatMap(l => [...this.extractKeywords(l.lesson)]);
    const freq = new Map<string, number>();
    for (const w of allWords) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }

    const topWords = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    return `${lessons[0].category}: ${topWords.join(', ')}`;
  }

  private synthesizeInstruction(lessons: Lesson[]): string {
    // Combine the lesson statements into a coherent instruction
    const parts = lessons.map(l => l.lesson);

    if (parts.length === 1) return parts[0];

    // If all lessons share a common theme, synthesize
    return parts.length <= 3
      ? parts.join('. ')
      : `${lessons[0].category} best practice: ${parts.slice(0, 3).join('; ')} (${parts.length - 3} more related lessons)`;
  }

  private async persistLesson(lesson: Lesson): Promise<void> {
    const filePath = join(this.lessonsDir, `${lesson.id}.json`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(lesson, null, 2), 'utf-8');
  }

  private async persistSkill(skill: Skill): Promise<void> {
    const filePath = join(this.skillsDir, `${skill.name}.md`);
    await mkdir(dirname(filePath), { recursive: true });

    const content = [
      `# ${skill.name}`,
      '',
      `**Category:** ${skill.category}`,
      `**Promoted:** ${skill.promotedAt}`,
      `**Source lessons:** ${skill.sourceLessons.join(', ')}`,
      '',
      '## Instruction',
      '',
      skill.instruction,
      '',
      '---',
      '',
      `*Auto-promoted by Lodestone Skill Evolver on ${skill.promotedAt}*`,
    ].join('\n');

    await writeFile(filePath, content, 'utf-8');
  }

  private parseSkillMarkdown(content: string): Skill | null {
    try {
      const nameMatch = content.match(/^# (.+)$/m);
      const categoryMatch = content.match(/\*\*Category:\*\* (.+)$/m);
      const promotedMatch = content.match(/\*\*Promoted:\*\* (.+)$/m);
      const sourceMatch = content.match(/\*\*Source lessons:\*\* (.+)$/m);
      const instructionMatch = content.match(/## Instruction\s*\n\n([\s\S]+?)(?:\n---|$)/);

      if (!nameMatch) return null;

      return {
        name: nameMatch[1],
        instruction: instructionMatch?.[1]?.trim() || '',
        sourceLessons: sourceMatch?.[1]?.split(', ') || [],
        promotedAt: promotedMatch?.[1] || new Date().toISOString(),
        category: categoryMatch?.[1] || 'general',
      };
    } catch {
      return null;
    }
  }
}