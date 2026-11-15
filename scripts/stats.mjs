#!/usr/bin/env node
import os from 'node:os';
import { ValidationError, getStateHome } from './lib/core.mjs';
import { formatStats, loadStats, parseStatsArgs } from './lib/stats.mjs';

const USAGE = `Usage: node scripts/stats.mjs [--json] [--workdir <dir>] [--help]

Options:
  --workdir <dir>  Filter jobs by exact normalized working directory
  --json           Output machine-readable JSON report
  --help, -h       Show this help message
`;

function main() {
  const opts = parseStatsArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const platform = process.platform;
  const homeDir = os.homedir();
  const stateHome = getStateHome(process.env, homeDir, platform);
  const stats = loadStats({
    stateHome,
    workDir: opts.workdir,
    platform,
    cwd: process.cwd(),
    homeDir,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  } else {
    process.stdout.write(formatStats(stats, { workDir: opts.workdir }));
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  if (err instanceof ValidationError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Error: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
}
