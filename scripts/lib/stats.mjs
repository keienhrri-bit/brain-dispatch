import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ValidationError,
  expandHome,
  getStateHome,
  isSamePath,
  normalizePath,
  stripBom,
} from './core.mjs';

export const USAGE_NOTE =
  'Captured jobs only, not main-brain tokens. Totals use backend-reported tokens, not price or subscription quota; conversation usage may be cumulative and must not be interpreted as billed per-call tokens.';

function formatFsError(err) {
  const code = err?.code ? `${err.code}: ` : '';
  const msg = err?.message || String(err);
  return err?.code && msg.includes(err.code) ? msg : `${code}${msg}`;
}

function readUtf8NoFollow(filePath) {
  const noFollow = fs.constants?.O_NOFOLLOW ?? 0;
  if (noFollow) {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        const err = new Error('Not a regular file');
        err.code = st.isDirectory() ? 'EISDIR' : 'EINVAL';
        throw err;
      }
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  return fs.readFileSync(filePath, 'utf8');
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return 'metadata must be a JSON object';
  }
  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    return 'missing or invalid string field "name"';
  }
  if (typeof meta.model !== 'string' || !meta.model.trim()) {
    return 'missing or invalid string field "model"';
  }
  if (typeof meta.work_dir !== 'string' || !meta.work_dir.trim()) {
    return 'missing or invalid string field "work_dir"';
  }
  if (typeof meta.ok !== 'boolean') {
    return 'missing or invalid boolean field "ok"';
  }
  return null;
}

function extractTotalTokens(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const total = usage.total_tokens;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    return null;
  }
  return total === 0 ? 0 : total;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function createEmptyReport(warnings = []) {
  return {
    jobs: 0,
    accepted: 0,
    rejected: 0,
    partial: 0,
    followUps: 0,
    seconds: 0,
    reportedTokens: 0,
    jobsWithUsage: 0,
    jobsWithoutUsage: 0,
    byModel: [],
    warnings,
    note: USAGE_NOTE,
  };
}

/**
 * Parse CLI arguments for scripts/stats.mjs.
 */
export function parseStatsArgs(argv) {
  const opts = {
    json: false,
    workdir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      opts.help = true;
      return opts;
    }
    if (token === '--json') {
      opts.json = true;
      continue;
    }
    if (token === '--workdir') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new ValidationError('Missing value for --workdir');
      }
      const val = argv[i + 1];
      i += 1;
      if (!val.trim()) {
        throw new ValidationError('Invalid --workdir: value cannot be empty');
      }
      opts.workdir = val;
      continue;
    }
    if (token.startsWith('--workdir=')) {
      const val = token.slice('--workdir='.length);
      if (!val.trim()) {
        throw new ValidationError('Invalid --workdir: value cannot be empty');
      }
      opts.workdir = val;
      continue;
    }
    throw new ValidationError(`Unknown or unexpected argument: ${token}`);
  }

  return opts;
}

/**
 * Aggregate read-only job usage statistics from jobs/<id>/meta.json under stateHome.
 */
export function loadStats({
  stateHome,
  workDir = null,
  platform = process.platform,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  fsOps = {},
} = {}) {
  let filterWorkDir = null;
  if (workDir !== null && workDir !== undefined) {
    if (typeof workDir !== 'string' || !workDir.trim()) {
      throw new ValidationError('Invalid workDir: value cannot be empty');
    }
    filterWorkDir = normalizePath(expandHome(workDir, homeDir), platform, cwd);
  }

  const resolvedStateHome =
    stateHome !== undefined && stateHome !== null
      ? String(stateHome)
      : getStateHome(process.env, homeDir, platform, cwd);
  const jobsDir = path.join(resolvedStateHome, 'jobs');

  const lstatSync = fsOps.lstatSync ?? fs.lstatSync;
  const readdirSync = fsOps.readdirSync ?? fs.readdirSync;
  const readFileSync = fsOps.readFileSync ?? readUtf8NoFollow;
  const warnings = [];

  let jobsStat;
  try {
    jobsStat = lstatSync(jobsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createEmptyReport(warnings);
    }
    warnings.push(`Cannot access jobs directory ${jobsDir}: ${formatFsError(err)}`);
    return createEmptyReport(warnings);
  }

  if (jobsStat.isSymbolicLink()) {
    warnings.push(`Skipped symbolic link jobs directory: ${jobsDir}`);
    return createEmptyReport(warnings);
  }
  if (!jobsStat.isDirectory()) {
    warnings.push(`Jobs path is not a directory: ${jobsDir}`);
    return createEmptyReport(warnings);
  }

  let entries;
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createEmptyReport(warnings);
    }
    warnings.push(`Cannot read jobs directory ${jobsDir}: ${formatFsError(err)}`);
    return createEmptyReport(warnings);
  }

  const sortedEntries = [...entries].sort((a, b) => compareStrings(a.name, b.name));

  let jobs = 0;
  let accepted = 0;
  let rejected = 0;
  let partial = 0;
  let followUps = 0;
  let seconds = 0;
  let reportedTokens = 0;
  let jobsWithUsage = 0;
  let jobsWithoutUsage = 0;
  const byModelMap = new Map();

  for (const entry of sortedEntries) {
    const jobDir = path.join(jobsDir, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped symbolic link job directory: ${jobDir}`);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    const metaPath = path.join(jobDir, 'meta.json');
    let metaStat;
    try {
      metaStat = lstatSync(metaPath);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        continue;
      }
      warnings.push(`Cannot access metadata ${metaPath}: ${formatFsError(err)}`);
      continue;
    }

    if (metaStat.isSymbolicLink()) {
      warnings.push(`Skipped symbolic link metadata file: ${metaPath}`);
      continue;
    }
    if (!metaStat.isFile()) {
      warnings.push(`Skipped non-file metadata path: ${metaPath}`);
      continue;
    }

    let raw;
    try {
      raw = readFileSync(metaPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        continue;
      }
      if (err?.code === 'ELOOP') {
        warnings.push(`Skipped symbolic link metadata file: ${metaPath}`);
        continue;
      }
      warnings.push(`Cannot read metadata ${metaPath}: ${formatFsError(err)}`);
      continue;
    }

    let meta;
    try {
      meta = JSON.parse(stripBom(raw));
    } catch (err) {
      warnings.push(`Invalid JSON in ${metaPath}: ${err.message}`);
      continue;
    }

    const invalidReason = validateMeta(meta);
    if (invalidReason) {
      warnings.push(`Invalid metadata in ${metaPath}: ${invalidReason}`);
      continue;
    }

    if (filterWorkDir !== null && !isSamePath(meta.work_dir, filterWorkDir, platform, cwd)) {
      continue;
    }

    jobs += 1;
    if (meta.ok) {
      accepted += 1;
    } else {
      rejected += 1;
    }
    if (meta.report_status === 'partial') {
      partial += 1;
    }
    if (typeof meta.follow_up_of === 'string' && meta.follow_up_of.trim()) {
      followUps += 1;
    }
    if (typeof meta.seconds === 'number' && Number.isFinite(meta.seconds) && meta.seconds >= 0) {
      seconds += meta.seconds === 0 ? 0 : meta.seconds;
    }

    const modelName = meta.model.trim();
    let modelStats = byModelMap.get(modelName);
    if (!modelStats) {
      modelStats = {
        model: modelName,
        jobs: 0,
        reportedTokens: 0,
        jobsWithUsage: 0,
        jobsWithoutUsage: 0,
      };
      byModelMap.set(modelName, modelStats);
    }
    modelStats.jobs += 1;

    const totalTokens = extractTotalTokens(meta.usage);
    if (totalTokens !== null) {
      reportedTokens += totalTokens;
      jobsWithUsage += 1;
      modelStats.reportedTokens += totalTokens;
      modelStats.jobsWithUsage += 1;
    } else {
      jobsWithoutUsage += 1;
      modelStats.jobsWithoutUsage += 1;
    }
  }

  const byModel = [...byModelMap.values()].sort((a, b) => compareStrings(a.model, b.model));

  return {
    jobs,
    accepted,
    rejected,
    partial,
    followUps,
    seconds,
    reportedTokens,
    jobsWithUsage,
    jobsWithoutUsage,
    byModel,
    warnings,
    note: USAGE_NOTE,
  };
}

/**
 * Format stats as a concise plain-text report.
 */
export function formatStats(stats, { workDir = null } = {}) {
  const lines = [];
  const secsLabel = Number.isInteger(stats.seconds)
    ? `${stats.seconds}s`
    : `${Number(stats.seconds.toFixed(1))}s`;

  lines.push(workDir ? `Worker stats (workdir: ${workDir}):` : 'Worker stats:');
  lines.push(
    `  Jobs: ${stats.jobs} (accepted ${stats.accepted}, failed ${stats.rejected}, partial ${stats.partial}, follow-ups ${stats.followUps}, time ${secsLabel})`
  );
  lines.push(
    `  Reported tokens: ${stats.reportedTokens.toLocaleString('en-US')} (${stats.jobsWithUsage} with usage, ${stats.jobsWithoutUsage} unknown usage)`
  );

  if (stats.byModel.length === 0) {
    lines.push('  By model: none');
  } else {
    lines.push('  By model:');
    const width = Math.max(...stats.byModel.map((m) => m.model.length));
    for (const m of stats.byModel) {
      lines.push(
        `    ${m.model.padEnd(width)}  jobs=${m.jobs}  tokens=${m.reportedTokens.toLocaleString('en-US')}  usage=${m.jobsWithUsage} known, ${m.jobsWithoutUsage} unknown`
      );
    }
  }

  if (stats.warnings.length > 0) {
    lines.push(`  Warnings (${stats.warnings.length}):`);
    for (const w of stats.warnings) {
      lines.push(`    - ${w}`);
    }
  }

  lines.push(`Note: ${stats.note}`);
  return `${lines.join('\n')}\n`;
}
