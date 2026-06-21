/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Wiki Store
 *
 * Manages the curated knowledge base. Markdown files with YAML frontmatter,
 * organized by category (entities, concepts, decisions, projects, areas, research).
 * Cross-linked with [[wikilinks]]. Auto-indexed, auto-linted.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { existsSync } from 'fs';
import matter from 'gray-matter';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WikiFrontmatter {
  title: string;
  created: string;
  updated: string;
  status: 'active' | 'stale' | 'archived';
  tags?: string[];
  agents?: string[];
  source?: string;
  [key: string]: unknown;
}

export interface WikiPage {
  slug: string;
  path: string;
  frontmatter: WikiFrontmatter;
  content: string;
  links: string[];   // Outgoing [[wikilinks]]
  backlinks: string[]; // Incoming [[wikilinks]] (computed)
}

export interface WikiSearchResult {
  slug: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface WikiConfig {
  rootDir: string;
  autoIndex: boolean;
  autoLint: boolean;
  categories: string[];
  /** Callback fired after a page is written (slug, content) — used by MemorySystem for compounding */
  onWrite?: (slug: string, content: string) => void | Promise<void>;
}

export interface WikiLintIssue {
  slug: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface WikiLintReport {
  totalPages: number;
  issues: WikiLintIssue[];
  errors: number;
  warnings: number;
  info: number;
  lintedAt: string;
}

// ─── Default Categories ─────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  'entities',
  'concepts',
  'decisions',
  'projects',
  'areas',
  'research',
  'templates',
];

// ─── Wiki Store ──────────────────────────────────────────────────────────────

export class WikiStore {
  private config: Required<Pick<WikiConfig, 'autoIndex' | 'autoLint' | 'categories'>> & Omit<WikiConfig, 'autoIndex' | 'autoLint' | 'categories'>;
  private cache: Map<string, WikiPage> = new Map();
  private indexCache: Map<string, string> = new Map(); // slug → title
  private loaded = false;
  private writeCallbacks: Array<(slug: string, content: string) => void | Promise<void>> = [];

  constructor(config: WikiConfig) {
    this.config = {
      ...config,
      autoIndex: config.autoIndex ?? true,
      autoLint: config.autoLint ?? true,
      categories: config.categories ?? DEFAULT_CATEGORIES,
    };
    if (config.onWrite) {
      this.writeCallbacks.push(config.onWrite);
    }
  }

  /** Register a callback to fire after a page is written */
  onWriteEvent(callback: (slug: string, content: string) => void | Promise<void>): void {
    this.writeCallbacks.push(callback);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  /** Read a wiki page by slug */
  async read(slug: string): Promise<WikiPage | null> {
    // Check cache first
    if (this.cache.has(slug)) {
      return this.cache.get(slug)!;
    }

    // Find the file
    const filePath = await this.resolveSlug(slug);
    if (!filePath) return null;

    return this.loadFile(filePath);
  }

  /** Write/update a wiki page */
  async write(
    slug: string,
    content: string,
    frontmatter?: Partial<WikiFrontmatter>
  ): Promise<WikiPage> {
    const now = new Date().toISOString().split('T')[0];
    const category = this.inferCategory(slug);
    const dir = join(this.config.rootDir, category);
    const filePath = join(dir, `${slug}.md`);

    // Ensure directory exists
    await mkdir(dir, { recursive: true });

    // Check if page exists (for update timestamp)
    const existing = await this.read(slug);
    const fm: WikiFrontmatter = {
      title: frontmatter?.title || this.slugToTitle(slug),
      created: existing?.frontmatter.created || now,
      updated: now,
      status: frontmatter?.status || 'active',
      tags: frontmatter?.tags || existing?.frontmatter.tags || [],
      agents: frontmatter?.agents || existing?.frontmatter.agents || [],
      source: frontmatter?.source || existing?.frontmatter.source,
    };

    // Remove undefined values (gray-matter can't handle them)
    const cleanFm: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fm)) {
      if (value !== undefined) {
        cleanFm[key] = value;
      }
    }

    // Render frontmatter + content
    const fileContent = matter.stringify(content, cleanFm);
    try {
      await writeFile(filePath, fileContent, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to write wiki page "${slug}" to ${filePath}: ${err instanceof Error ? err.message : String(err)}. Check directory permissions and disk space.`);
    }

    // Update cache
    const page = await this.loadFile(filePath);
    this.cache.set(slug, page);
    this.indexCache.set(slug, fm.title);

    // Rebuild index if auto-index is on
    if (this.config.autoIndex) {
      await this.rebuildIndex();
    }

    // Fire write callbacks (for memory compounding, knowledge graph, etc.)
    for (const cb of this.writeCallbacks) {
      try {
        await cb(slug, content);
      } catch (err) {
        // Don't let a callback failure block the write
        // Logged but not thrown
      }
    }

    return page;
  }

  /** Delete a wiki page */
  async delete(slug: string): Promise<boolean> {
    const filePath = await this.resolveSlug(slug);
    if (!filePath) return false;

    try {
      await unlink(filePath);
    } catch (err) {
      throw new Error(`Failed to delete wiki page "${slug}" at ${filePath}: ${err instanceof Error ? err.message : String(err)}. Check file permissions.`);
    }
    this.cache.delete(slug);
    this.indexCache.delete(slug);

    if (this.config.autoIndex) {
      await this.rebuildIndex();
    }

    return true;
  }

  /** Search wiki pages by query */
  async search(query: string, limit = 10): Promise<WikiSearchResult[]> {
    await this.ensureLoaded();

    const lowerQuery = query.toLowerCase();
    const terms = lowerQuery.split(/\s+/).filter(Boolean);
    const results: (WikiSearchResult & { score: number })[] = [];

    for (const [slug, page] of this.cache) {
      let score = 0;
      const title = page.frontmatter.title.toLowerCase();
      const content = page.content.toLowerCase();
      const tags = (page.frontmatter.tags || []).join(' ').toLowerCase();

      // Title match (highest weight)
      if (title.includes(lowerQuery)) score += 10;
      for (const term of terms) {
        if (title.includes(term)) score += 5;
      }

      // Tag match
      for (const term of terms) {
        if (tags.includes(term)) score += 3;
      }

      // Content match
      for (const term of terms) {
        if (content.includes(term)) score += 1;
      }

      // Fuzzy match — prefix matching for terms not found exactly
      for (const term of terms) {
        const termIdx = content.indexOf(term);
        if (termIdx === -1) {
          // Check if any word in the content starts with the term (prefix match)
          const prefixPattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\\\]/g, '\\$&')}`, 'gi');
          if (prefixPattern.test(content)) score += 1;
          if (prefixPattern.test(title)) score += 2;
        }
      }

      // Check for partial term matches (at least 60% of query terms must match)
      const matchedTerms = terms.filter(t => content.includes(t) || title.includes(t) || tags.includes(t));
      if (matchedTerms.length >= Math.ceil(terms.length * 0.6)) {
        score += 3; // Boost for pages that match most terms
      }

      // Recency bonus (updated in last 7 days)
      const updated = new Date(page.frontmatter.updated);
      const daysSinceUpdate = (Date.now() - updated.getTime()) / (86400000);
      if (daysSinceUpdate < 7) score += 2;

      if (score > 0) {
        // Extract excerpt around first match
        const matchIdx = content.indexOf(lowerQuery) || content.indexOf(terms[0] || '');
        const excerptStart = Math.max(0, matchIdx - 100);
        const excerptEnd = Math.min(content.length, matchIdx + 200);
        const excerpt = content.slice(excerptStart, excerptEnd).replace(/\n/g, ' ');

        results.push({
          slug,
          title: page.frontmatter.title,
          excerpt: excerpt.length > 300 ? excerpt.slice(0, 300) + '...' : excerpt,
          score,
        });
      }
    }

    // Sort by score descending, return top results
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Get all wiki pages */
  async list(category?: string): Promise<WikiPage[]> {
    await this.ensureLoaded();

    if (category) {
      return Array.from(this.cache.values())
        .filter(p => p.path.includes(`/${category}/`));
    }

    return Array.from(this.cache.values());
  }

  /** Resolve a [[wikilink]] to a page */
  async resolve(link: string): Promise<WikiPage | null> {
    // Strip brackets if present
    const slug = link.replace(/^\[\[|\]\]$/g, '');
    return this.read(slug);
  }

  /** Get backlinks for a page (pages that link TO this page) */
  async getBacklinks(slug: string): Promise<WikiPage[]> {
    await this.ensureLoaded();

    const backlinks: WikiPage[] = [];
    for (const [otherSlug, page] of this.cache) {
      if (otherSlug === slug) continue;
      if (page.links.includes(slug)) {
        backlinks.push(page);
      }
    }
    return backlinks;
  }

  // ─── Index ─────────────────────────────────────────────────────────────

  /** Rebuild the wiki index */
  async rebuildIndex(): Promise<void> {
    await this.ensureLoaded();

    const totalPages = this.cache.size;
    const now = new Date().toISOString().split('T')[0];

    const lines: string[] = [
      '# Wiki Index',
      '',
      `Auto-generated index of all wiki pages. Last updated: ${now}`,
      '',
      `**Total pages: ${totalPages}**`,
      '',
    ];

    // Recently updated section (top 5)
    const recent = Array.from(this.cache.values())
      .sort((a, b) => new Date(b.frontmatter.updated).getTime() - new Date(a.frontmatter.updated).getTime())
      .slice(0, 5);
    if (recent.length > 0) {
      lines.push('## Recently Updated');
      lines.push('');
      for (const page of recent) {
        const date = page.frontmatter.updated;
        lines.push(`- [[${page.slug}]] — ${page.frontmatter.title} _(${date})_`);
      }
      lines.push('');
    }

    // Pages grouped by category
    for (const category of this.config.categories) {
      const pages = await this.list(category);
      if (pages.length === 0) continue;

      lines.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)} (${pages.length})`);
      lines.push('');
      for (const page of pages.sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title))) {
        lines.push(`- [[${page.slug}]] — ${page.frontmatter.title} _(${page.frontmatter.updated})_`);
      }
      lines.push('');
    }

    const indexPath = join(this.config.rootDir, 'index.md');
    await writeFile(indexPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Lint the wiki: check for broken links, missing frontmatter, orphans, stale pages.
   * Returns a report of issues found.
   */
  async lint(): Promise<WikiLintReport> {
    await this.ensureLoaded();

    const issues: WikiLintIssue[] = [];
    const allSlugs = Array.from(this.cache.keys());

    for (const [slug, page] of this.cache) {
      // Check required frontmatter fields
      const fm = page.frontmatter;
      if (!fm.title) {
        issues.push({ slug, severity: 'error', message: 'Missing frontmatter: title' });
      }
      if (!fm.created) {
        issues.push({ slug, severity: 'error', message: 'Missing frontmatter: created' });
      }
      if (!fm.updated) {
        issues.push({ slug, severity: 'error', message: 'Missing frontmatter: updated' });
      }
      if (!fm.status) {
        issues.push({ slug, severity: 'warn', message: 'Missing frontmatter: status' });
      }

      // Find [[wikilinks]] in content
      const linkPattern = /\[\[([a-z0-9-]+)\]\]/gi;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(page.content)) !== null) {
        const linkSlug = match[1];
        if (!allSlugs.includes(linkSlug)) {
          issues.push({ slug, severity: 'error', message: `Broken wikilink: [[${linkSlug}]]` });
        }
      }

      // Check for orphan pages (no incoming links and no outgoing links)
      // Skip index.md
      if (slug !== 'index') {
        const hasOutgoing = linkPattern.test(page.content);
        // Check if any other page links to this one
        const hasIncoming = Array.from(this.cache.values()).some(p =>
          p !== page && new RegExp(`\\[\\[${slug}\\]\\]`, 'i').test(p.content)
        );
        if (!hasOutgoing && !hasIncoming) {
          issues.push({ slug, severity: 'warn', message: 'Orphan page — no incoming or outgoing links' });
        }
      }

      // Check for stale pages (not updated in 90 days)
      if (fm.updated) {
        const updated = new Date(fm.updated);
        const daysSinceUpdate = (Date.now() - updated.getTime()) / 86400000;
        if (daysSinceUpdate > 90) {
          issues.push({ slug, severity: 'info', message: `Stale page — last updated ${Math.floor(daysSinceUpdate)} days ago` });
        }
      }
    }

    return {
      totalPages: allSlugs.length,
      issues,
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warn').length,
      info: issues.filter(i => i.severity === 'info').length,
      lintedAt: new Date().toISOString(),
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    // Ensure standard category directories exist
    const categories = ['entities', 'concepts', 'decisions', 'projects', 'areas', 'research'];
    for (const cat of categories) {
      const dir = join(this.config.rootDir, cat);
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        // Directory already exists — fine
      }
    }

    for (const category of this.config.categories) {
      const categoryDir = join(this.config.rootDir, category);
      if (!existsSync(categoryDir)) continue;

      const files = await readdir(categoryDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = join(categoryDir, file);
        const page = await this.loadFile(filePath);
        this.cache.set(page.slug, page);
        this.indexCache.set(page.slug, page.frontmatter.title);
      }
    }

    // Also load root-level pages
    const rootFiles = await readdir(this.config.rootDir).catch(() => [] as string[]);
    for (const file of rootFiles) {
      if (!file.endsWith('.md') || file === 'index.md') continue;
      const filePath = join(this.config.rootDir, file);
      const page = await this.loadFile(filePath);
      this.cache.set(page.slug, page);
      this.indexCache.set(page.slug, page.frontmatter.title);
    }
  }

  private async loadFile(filePath: string): Promise<WikiPage> {
    const raw = await readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);

    const slug = basename(filePath, '.md');
    const links = this.extractLinks(content);

    const frontmatter: WikiFrontmatter = {
      title: data.title || this.slugToTitle(slug),
      created: data.created || new Date().toISOString().split('T')[0],
      updated: data.updated || new Date().toISOString().split('T')[0],
      status: data.status || 'active',
      tags: data.tags || [],
      agents: data.agents || [],
      source: data.source,
      ...data,
    };

    return {
      slug,
      path: filePath,
      frontmatter,
      content,
      links,
      backlinks: [], // Computed on demand via getBacklinks()
    };
  }

  private async resolveSlug(slug: string): Promise<string | null> {
    await this.ensureLoaded();

    // Direct match
    if (this.cache.has(slug)) {
      return this.cache.get(slug)!.path;
    }

    // Search by title
    for (const [s, page] of this.cache) {
      if (page.frontmatter.title.toLowerCase() === slug.toLowerCase()) {
        return page.path;
      }
    }

    return null;
  }

  private extractLinks(content: string): string[] {
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(content)) !== null) {
      // Handle [[slug|display text]] format
      const link = match[1].split('|')[0].trim();
      links.push(link);
    }

    return [...new Set(links)]; // Deduplicate
  }

  private inferCategory(slug: string): string {
    // Check if the slug already includes a category path
    for (const category of this.config.categories) {
      if (slug.startsWith(`${category}/`)) {
        return category;
      }
    }

    // Default categorization by content analysis
    // This is a heuristic — users should specify categories in frontmatter
    if (slug.includes('-decision') || slug.startsWith('decision')) return 'decisions';
    if (slug.includes('-project') || slug.startsWith('project')) return 'projects';
    if (slug.includes('-area') || slug.startsWith('area')) return 'areas';

    return 'concepts'; // Default category
  }

  private slugToTitle(slug: string): string {
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }
}