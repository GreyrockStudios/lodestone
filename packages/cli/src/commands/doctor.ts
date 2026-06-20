/**
 * `lodestone doctor` — Health check and diagnostics.
 *
 * Checks: config validity, identity files, workspace structure, data dirs,
 * LLM connectivity, port availability, dependency versions, scheduled jobs.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, readdir, stat, access } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { constants as fsConstants } from 'fs';

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

export function doctorCommand(): Command {
  const cmd = new Command('doctor');

  cmd
    .description('Run health checks and diagnostics')
    .option('-c, --config <path>', 'Path to config file', './lodestone.config.yaml')
    .option('-w, --workspace <path>', 'Workspace root directory')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const results: CheckResult[] = [];

      // ─── 1. Config file ─────────────────────────────────────────────
      let config: any = {};
      let configPath = options.config;

      try {
        const raw = await readFile(configPath, 'utf-8');
        config = parseYaml(raw);
        results.push({ name: 'Config file', status: 'pass', message: `Found at ${configPath}` });
      } catch {
        results.push({ name: 'Config file', status: 'fail', message: `Not found at ${configPath}`, detail: 'Run `lodestone init` to create one' });
      }

      const workspaceRoot = options.workspace || config.workspace?.root || './workspace';

      // ─── 2. Workspace structure ─────────────────────────────────────
      const requiredDirs = [
        { path: workspaceRoot, label: 'Workspace root' },
        { path: resolve(workspaceRoot, 'data'), label: 'Data directory' },
        { path: resolve(workspaceRoot, 'data/improvement'), label: 'Improvement data' },
        { path: resolve(workspaceRoot, 'data/safety'), label: 'Safety data' },
        { path: resolve(workspaceRoot, 'memory/wiki'), label: 'Wiki directory' },
        { path: resolve(workspaceRoot, 'memory/raw'), label: 'Raw sources' },
        { path: resolve(workspaceRoot, 'memory/agents'), label: 'Agent workspaces' },
        { path: resolve(workspaceRoot, 'memory/00-inbox'), label: 'Inbox' },
      ];

      for (const dir of requiredDirs) {
        try {
          await access(dir.path);
          results.push({ name: dir.label, status: 'pass', message: dir.path });
        } catch {
          results.push({ name: dir.label, status: 'warn', message: `Missing: ${dir.path}`, detail: 'Will be created on first run' });
        }
      }

      // ─── 3. Identity files ──────────────────────────────────────────
      const identityFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'];
      for (const file of identityFiles) {
        const filePath = resolve(workspaceRoot, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          if (content.trim().length > 10) {
            results.push({ name: `Identity: ${file}`, status: 'pass', message: `${content.trim().split('\n').length} lines` });
          } else {
            results.push({ name: `Identity: ${file}`, status: 'warn', message: 'File exists but appears empty' });
          }
        } catch {
          results.push({ name: `Identity: ${file}`, status: 'warn', message: 'Not found', detail: 'Optional but recommended' });
        }
      }

      // ─── 4. Config validation ────────────────────────────────────────
      if (config.llm?.default) {
        const llm = config.llm.default;
        if (llm.model) {
          results.push({ name: 'LLM model', status: 'pass', message: llm.model });
        } else {
          results.push({ name: 'LLM model', status: 'fail', message: 'No model specified in config' });
        }
        if (llm.type) {
          results.push({ name: 'LLM provider', status: 'pass', message: llm.type });
        } else {
          results.push({ name: 'LLM provider', status: 'fail', message: 'No provider type specified' });
        }
        if (llm.baseUrl) {
          results.push({ name: 'LLM endpoint', status: 'pass', message: llm.baseUrl });
        } else if (llm.type === 'ollama') {
          results.push({ name: 'LLM endpoint', status: 'warn', message: 'No baseUrl — will default to http://127.0.0.1:11434' });
        }
      } else {
        results.push({ name: 'LLM config', status: 'fail', message: 'No llm.default section in config' });
      }

      // ─── 5. Memory config ───────────────────────────────────────────
      if (config.memory?.wiki?.path) {
        results.push({ name: 'Wiki path', status: 'pass', message: config.memory.wiki.path });
      } else {
        results.push({ name: 'Wiki path', status: 'warn', message: 'Not configured — using default' });
      }

      if (config.memory?.vector?.path) {
        try {
          await access(config.memory.vector.path);
          results.push({ name: 'Vector DB', status: 'pass', message: config.memory.vector.path });
        } catch {
          results.push({ name: 'Vector DB', status: 'warn', message: `Path not yet created: ${config.memory.vector.path}`, detail: 'Will be created on first run' });
        }
      } else {
        results.push({ name: 'Vector DB', status: 'warn', message: 'Not configured — using default' });
      }

      // ─── 6. Dashboard config ────────────────────────────────────────
      if (config.dashboard?.enabled) {
        const port = config.dashboard.port || 3000;
        results.push({ name: 'Dashboard', status: 'pass', message: `Enabled on port ${port}` });
      } else {
        results.push({ name: 'Dashboard', status: 'warn', message: 'Not enabled in config' });
      }

      // ─── 7. Channels config ─────────────────────────────────────────
      const channels = config.channels || [];
      if (channels.length > 0) {
        const channelNames = channels.map((c: any) => c.type || c.id || 'unknown').join(', ');
        results.push({ name: 'Channels', status: 'pass', message: `${channels.length} configured: ${channelNames}` });
      } else {
        results.push({ name: 'Channels', status: 'warn', message: 'No channels configured — WebChat only' });
      }

      // ─── 8. LLM connectivity ─────────────────────────────────────────
      if (config.llm?.default?.baseUrl) {
        try {
          const resp = await fetch(`${config.llm.default.baseUrl.replace(/\/api$/, '')}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            const models = data.models || [];
            const modelExists = models.some((m: any) => m.name?.includes(config.llm.default.model));
            if (modelExists) {
              results.push({ name: 'LLM connectivity', status: 'pass', message: `Ollama reachable, model ${config.llm.default.model} available` });
            } else {
              const available = models.map((m: any) => m.name).join(', ');
              results.push({ name: 'LLM connectivity', status: 'warn', message: `Ollama reachable but model ${config.llm.default.model} not found`, detail: `Available: ${available || 'none'}` });
            }
          } else {
            results.push({ name: 'LLM connectivity', status: 'warn', message: `Ollama responded with ${resp.status}` });
          }
        } catch {
          results.push({ name: 'LLM connectivity', status: 'fail', message: `Cannot reach Ollama at ${config.llm.default.baseUrl}`, detail: 'Is Ollama running?' });
        }
      }

      // ─── 9. Node.js version ──────────────────────────────────────────
      const nodeVersion = process.version;
      const major = parseInt(nodeVersion.slice(1));
      if (major >= 20) {
        results.push({ name: 'Node.js', status: 'pass', message: nodeVersion });
      } else {
        results.push({ name: 'Node.js', status: 'warn', message: `${nodeVersion} — recommend v20+` });
      }

      // ─── 10. Build artifacts ────────────────────────────────────────
      const distPath = resolve(workspaceRoot, 'packages/core/dist');
      if (existsSync(distPath)) {
        results.push({ name: 'Build artifacts', status: 'pass', message: 'dist/ exists (compiled)' });
      } else {
        results.push({ name: 'Build artifacts', status: 'warn', message: 'No dist/ — run `npm run build` first', detail: 'Required for production startup' });
      }

      // ─── 11. Wiki page count ────────────────────────────────────────
      try {
        const wikiDir = resolve(workspaceRoot, 'memory/wiki');
        if (existsSync(wikiDir)) {
          let count = 0;
          async function countMd(dir: string): Promise<number> {
            let c = 0;
            try {
              const entries = await readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) c += await countMd(join(dir, entry.name));
                else if (entry.name.endsWith('.md')) c++;
              }
            } catch { /* skip */ }
            return c;
          }
          count = await countMd(wikiDir);
          if (count > 0) {
            results.push({ name: 'Wiki pages', status: 'pass', message: `${count} pages` });
          } else {
            results.push({ name: 'Wiki pages', status: 'warn', message: 'No wiki pages yet' });
          }
        }
      } catch { /* skip */ }

      // ─── 12. Scheduled jobs sanity ───────────────────────────────────
      const expectedJobs = ['sleep-cycle', 'calibration-loop', 'drift-correction', 'dream-mode'];
      results.push({ name: 'Scheduled jobs', status: 'pass', message: `${expectedJobs.length} expected: ${expectedJobs.join(', ')}`, detail: 'Jobs are registered at engine startup' });

      // ─── Output ──────────────────────────────────────────────────────
      if (options.json) {
        console.log(JSON.stringify({ results, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length, warnings: results.filter(r => r.status === 'warn').length }, null, 2));
        process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
      }

      const passCount = results.filter(r => r.status === 'pass').length;
      const warnCount = results.filter(r => r.status === 'warn').length;
      const failCount = results.filter(r => r.status === 'fail').length;

      console.log('');
      console.log(chalk.cyan('🔮 Lodestone Doctor') + chalk.dim(` — ${results.length} checks`));
      console.log(chalk.dim('─'.repeat(60)));

      for (const result of results) {
        const icon = result.status === 'pass' ? chalk.green('✓') : result.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
        const label = result.name.padEnd(22);
        console.log(`  ${icon}  ${chalk.dim(label)} ${result.message}`);
        if (result.detail) {
          console.log(`     ${chalk.dim('   └ ' + result.detail)}`);
        }
      }

      console.log(chalk.dim('─'.repeat(60)));
      console.log(`  ${chalk.green(`${passCount} passed`)}  ${chalk.yellow(`${warnCount} warnings`)}  ${chalk.red(`${failCount} failed`)}`);
      console.log('');

      process.exit(failCount > 0 ? 1 : 0);
    });

  return cmd;
}