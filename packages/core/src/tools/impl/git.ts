/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Tool — Git Operations
 *
 * Structured git operations: status, diff, log, branch, commit, checkout, add, push, pull.
 * Uses child_process.execFile with the git command for safety.
 */

import { execFile } from 'child_process';
import { resolve, relative, isAbsolute } from 'path';
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../definitions.js';

export interface GitToolConfig {
  /** Default repo path (default: workspaceRoot from context) */
  defaultRepo?: string;
}

type GitOperation = 'status' | 'diff' | 'log' | 'branch' | 'commit' | 'checkout' | 'add' | 'push' | 'pull' | 'listBranches' | 'merge' | 'currentBranch';

const MUTATING_OPS: GitOperation[] = ['commit', 'checkout', 'add', 'push', 'pull', 'merge'];

export class GitTool implements Tool {
  readonly definition: ToolDefinition = {
    id: 'git',
    name: 'Git Operations',
    description: 'Structured git operations: status, diff, log, branch, commit, checkout, add, push, pull.',
    parameters: [
      { name: 'operation', type: 'string', description: 'Git operation: status, diff, log, branch, listBranches, merge, currentBranch, commit, checkout, add, push, pull', required: true, enum: ['status', 'diff', 'log', 'branch', 'listBranches', 'merge', 'currentBranch', 'commit', 'checkout', 'add', 'push', 'pull'] },
      { name: 'args', type: 'string', description: 'Extra arguments (e.g., commit message for commit, branch name for merge)', required: false },
      { name: 'repo', type: 'string', description: 'Path to git repo (default: workspace root)', required: false },
      { name: 'mergeMode', type: 'string', description: 'Merge mode: merge (default), squash, no-ff', required: false, enum: ['merge', 'squash', 'no-ff'] },
    ],
    sideEffects: true,
    requiresApproval: true,
    timeout: 30000,
  };

  private config: GitToolConfig;

  constructor(config: GitToolConfig = {}) {
    this.config = config;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const operation = params.operation as GitOperation;
    const args = (params.args as string) || '';
    const repoParam = (params.repo as string) || this.config.defaultRepo || context.workspaceRoot;
    const start = Date.now();

    // Validate operation
    const validOps: GitOperation[] = ['status', 'diff', 'log', 'branch', 'listBranches', 'merge', 'currentBranch', 'commit', 'checkout', 'add', 'push', 'pull'];
    if (!validOps.includes(operation)) {
      return {
        success: false,
        data: null,
        summary: `Invalid operation: ${operation}`,
        error: `Valid operations: ${validOps.join(', ')}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    // Sandbox repo path
    const repo = this.sandboxPath(repoParam, context.workspaceRoot);
    if (!repo) {
      return {
        success: false,
        data: null,
        summary: `Repo path escapes workspace: ${repoParam}`,
        error: 'Path traversal denied',
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }

    try {
      switch (operation) {
        case 'status':
          return await this.status(repo, start);
        case 'diff':
          return await this.diff(repo, args, start);
        case 'log':
          return await this.log(repo, start);
        case 'branch':
          return await this.branch(repo, start);
        case 'listBranches':
          return await this.listBranches(repo, start);
        case 'merge':
          return await this.merge(repo, args, params.mergeMode as string | undefined, start);
        case 'currentBranch':
          return await this.currentBranch(repo, start);
        case 'commit':
          return await this.commit(repo, args, start);
        case 'checkout':
          return await this.checkout(repo, args, start);
        case 'add':
          return await this.add(repo, args, start);
        case 'push':
          return await this.push(repo, args, start);
        case 'pull':
          return await this.pull(repo, args, start);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown operation: ${operation}`,
            error: 'UnknownOperation',
            durationMs: Date.now() - start,
            includeInContext: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Git ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        error: `Git ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        includeInContext: false,
      };
    }
  }

  private sandboxPath(path: string, workspaceRoot: string): string | null {
    const resolved = isAbsolute(path) ? path : resolve(workspaceRoot, path);
    const rel = relative(workspaceRoot, resolved);
    if (rel.startsWith('..')) return null;
    return resolved;
  }

  private runGit(repo: string, gitArgs: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise) => {
      execFile('git', gitArgs, {
        cwd: repo,
        timeout: 25000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolvePromise({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err ? (err as { code?: number }).code ?? 1 : 0,
        });
      });
    });
  }

  private async status(repo: string, start: number): Promise<ToolResult> {
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['status', '--porcelain=v1']);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git status failed: ${stderr.slice(0, 200)}`,
        error: `Git status failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of stdout.split('\n').filter((l) => l.length > 0)) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);
      if (x === '?' && y === '?') {
        untracked.push(file);
      } else {
        if (x !== ' ' && x !== '?') staged.push(file);
        if (y !== ' ' && y !== '?') modified.push(file);
      }
    }

    return {
      success: true,
      data: { staged, modified, untracked },
      summary: `git status: ${staged.length} staged, ${modified.length} modified, ${untracked.length} untracked`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async diff(repo: string, args: string, start: number): Promise<ToolResult> {
    const gitArgs = ['diff'];
    if (args) gitArgs.push(...args.split(/\s+/));
    const { stdout, exitCode, stderr } = await this.runGit(repo, gitArgs);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git diff failed: ${stderr.slice(0, 200)}`,
        error: `Git diff failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    return {
      success: true,
      data: { diff: stdout },
      summary: `git diff (${stdout.length} chars)`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async log(repo: string, start: number): Promise<ToolResult> {
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['log', '--pretty=format:%H|%an|%ad|%s', '--date=iso', '-20']);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git log failed: ${stderr.slice(0, 200)}`,
        error: `Git log failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const commits = stdout.split('\n').filter((l) => l.length > 0).map((line) => {
      const [hash, author, date, ...msgParts] = line.split('|');
      return {
        hash,
        author,
        date,
        message: msgParts.join('|'),
      };
    });

    return {
      success: true,
      data: { commits, count: commits.length },
      summary: `git log: ${commits.length} commits`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async branch(repo: string, start: number): Promise<ToolResult> {
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['branch', '--list', '--all', '--format=%(refname:short)%09%(upstream:short)']);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git branch failed: ${stderr.slice(0, 200)}`,
        error: `Git branch failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Also get current branch
    const { stdout: currentOut } = await this.runGit(repo, ['branch', '--show-current']);
    const currentBranch = currentOut.trim();

    const branches = stdout.split('\n').filter((l) => l.length > 0).map((line) => {
      // Format: branchname\tremote (tab-separated if upstream exists)
      const [name, remote] = line.split('\t');
      return {
        name: name?.trim() || '',
        current: name?.trim() === currentBranch,
        remote: remote?.trim() || null,
      };
    });

    return {
      success: true,
      data: { branches, currentBranch },
      summary: `git branch: ${branches.length} branches (current: ${currentBranch})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  /**
   * List all local and remote branches with tracking info.
   * Returns structured data including remote tracking branches.
   */
  private async listBranches(repo: string, start: number): Promise<ToolResult> {
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['branch', '--list', '--all', '--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)']);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git listBranches failed: ${stderr.slice(0, 200)}`,
        error: `Git listBranches failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Get current branch
    const { stdout: currentOut } = await this.runGit(repo, ['branch', '--show-current']);
    const currentBranchName = currentOut.trim();

    const local: Array<{ name: string; current: boolean; upstream: string | null }> = [];
    const remote: Array<{ name: string; upstream: string | null }> = [];

    for (const line of stdout.split('\n').filter((l) => l.length > 0)) {
      const parts = line.split('\t');
      const name = parts[0]?.trim() || '';
      const upstream = parts[1]?.trim() || null;

      // Remote branches appear as 'origin/branch-name' with %(refname:short)
      // They don't start with 'remotes/' — that prefix is already stripped
      const isRemote = name.includes('/') && !name.startsWith('HEAD');

      if (isRemote && !local.some((b) => b.name === name.split('/').slice(1).join('/'))) {
        remote.push({ name, upstream });
      } else if (!isRemote) {
        local.push({ name, current: name === currentBranchName, upstream });
      }
    }

    return {
      success: true,
      data: { local, remote, currentBranch: currentBranchName, total: local.length + remote.length },
      summary: `git listBranches: ${local.length} local, ${remote.length} remote (current: ${currentBranchName})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  /**
   * Get the current branch name.
   */
  private async currentBranch(repo: string, start: number): Promise<ToolResult> {
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['branch', '--show-current']);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git currentBranch failed: ${stderr.slice(0, 200)}`,
        error: `Git currentBranch failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const branchName = stdout.trim();
    return {
      success: true,
      data: { branch: branchName },
      summary: `Current branch: ${branchName}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  /**
   * Merge a branch into the current branch.
   * Supports merge modes: merge (default), squash, no-ff.
   */
  private async merge(repo: string, args: string, mergeMode: string | undefined, start: number): Promise<ToolResult> {
    if (!args) {
      return {
        success: false, data: null,
        summary: 'Branch name required for merge (pass as args)',
        error: 'MissingBranch: merge requires a branch name as args',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    const branchToMerge = args.trim().split(/\s+/)[0];
    const mode = mergeMode || 'merge';

    // Build merge args based on mode
    const mergeArgs: string[] = ['merge'];
    if (mode === 'squash') {
      mergeArgs.push('--squash');
    } else if (mode === 'no-ff') {
      mergeArgs.push('--no-ff');
    }
    mergeArgs.push(branchToMerge);

    const { stdout, stderr, exitCode } = await this.runGit(repo, mergeArgs);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git merge failed: ${stderr.slice(0, 200)}`,
        error: `Git merge of '${branchToMerge}' failed: ${stderr.slice(0, 200)}`,
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // For squash merge, need to commit
    if (mode === 'squash') {
      const commitMsg = `Squash merge '${branchToMerge}'`;
      const { exitCode: commitExitCode, stderr: commitStderr } = await this.runGit(repo, ['commit', '-m', commitMsg]);
      if (commitExitCode !== 0) {
        return {
          success: false, data: null,
          summary: `git merge squash commit failed: ${commitStderr.slice(0, 200)}`,
          error: `Git squash merge commit failed: ${commitStderr.slice(0, 200)}`,
          durationMs: Date.now() - start, includeInContext: false,
        };
      }
    }

    // Get resulting HEAD info
    const { stdout: hashOut } = await this.runGit(repo, ['rev-parse', 'HEAD']);
    const { stdout: currentOut } = await this.runGit(repo, ['branch', '--show-current']);

    return {
      success: true,
      data: {
        mergedBranch: branchToMerge,
        intoBranch: currentOut.trim(),
        mode,
        resultingHash: hashOut.trim(),
        output: stdout,
      },
      summary: `Merged '${branchToMerge}' into '${currentOut.trim()}' (${mode})`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async commit(repo: string, args: string, start: number): Promise<ToolResult> {
    if (!args) {
      return {
        success: false, data: null,
        summary: 'Commit message required (pass as args)',
        error: 'MissingMessage',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Stage all tracked changes first
    await this.runGit(repo, ['add', '-A']);
    const { stdout, exitCode, stderr } = await this.runGit(repo, ['commit', '-m', args]);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git commit failed: ${stderr.slice(0, 200)}`,
        error: 'GitError',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }

    // Get the hash
    const { stdout: hashOut } = await this.runGit(repo, ['rev-parse', 'HEAD']);
    const { stdout: filesOut } = await this.runGit(repo, ['diff', '--name-only', 'HEAD~1', 'HEAD']);

    return {
      success: true,
      data: {
        hash: hashOut.trim(),
        filesChanged: filesOut.split('\n').filter((l) => l.length > 0),
        message: args,
      },
      summary: `Committed: ${hashOut.trim().slice(0, 8)} — ${args.slice(0, 60)}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async checkout(repo: string, args: string, start: number): Promise<ToolResult> {
    if (!args) {
      return {
        success: false, data: null,
        summary: 'Branch name required (pass as args)',
        error: 'MissingBranch',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    const { stdout, stderr, exitCode } = await this.runGit(repo, ['checkout', ...args.split(/\s+/)]);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git checkout failed: ${stderr.slice(0, 200)}`,
        error: 'GitError',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    return {
      success: true,
      data: { branch: args, output: stdout },
      summary: `Checked out: ${args}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async add(repo: string, args: string, start: number): Promise<ToolResult> {
    const addArgs = args ? args.split(/\s+/) : ['-A'];
    const { exitCode, stderr } = await this.runGit(repo, ['add', ...addArgs]);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git add failed: ${stderr.slice(0, 200)}`,
        error: 'GitError',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    return {
      success: true,
      data: { staged: addArgs },
      summary: `Staged: ${addArgs.join(' ')}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async push(repo: string, args: string, start: number): Promise<ToolResult> {
    const pushArgs = args ? args.split(/\s+/) : [];
    const { stdout, stderr, exitCode } = await this.runGit(repo, ['push', ...pushArgs]);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git push failed: ${stderr.slice(0, 200)}`,
        error: 'GitError',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    return {
      success: true,
      data: { output: stdout || stderr },
      summary: `Pushed to remote${args ? ` (${args})` : ''}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }

  private async pull(repo: string, args: string, start: number): Promise<ToolResult> {
    const pullArgs = args ? args.split(/\s+/) : [];
    const { stdout, stderr, exitCode } = await this.runGit(repo, ['pull', ...pullArgs]);
    if (exitCode !== 0) {
      return {
        success: false, data: null,
        summary: `git pull failed: ${stderr.slice(0, 200)}`,
        error: 'GitError',
        durationMs: Date.now() - start, includeInContext: false,
      };
    }
    return {
      success: true,
      data: { output: stdout || stderr },
      summary: `Pulled from remote${args ? ` (${args})` : ''}`,
      durationMs: Date.now() - start,
      includeInContext: true,
    };
  }
}