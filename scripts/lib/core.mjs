import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = Object.freeze({
  worker: Object.freeze({
    model: 'gemini-4-hydrogen',
    effort: 'high',
    timeoutMin: 20,
  }),
  protect: Object.freeze([]),
  proxy: null,
  agy: null,
  policyHook: true,
});

export const VALID_ACCESS = Object.freeze(['read', 'write', 'full']);
export const VALID_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const PROMPT_INLINE_LIMIT = 12000;
export const CONTEXT_LIMIT = 8000;
export const DEFAULT_KILL_GRACE_SEC = 60;
export const FALLBACK_HINT =
  'Fallback: hand the same brief to the brain-dispatch:backup-worker subagent (Sonnet), or to brain-dispatch:finder (Haiku) if the job only reads.';

// Command deny rules for `full` access. agy matches each `regex:` rule against the
// whole command string (Go RE2 syntax: no lookarounds). Patterns are anchored at
// both ends so they behave the same under full-match and search semantics, and
// `(?is)` lets `.` cross newlines in multi-line commands.
//
// Names that are distinctive enough are blocked wherever they appear as a word.
// Short or common names (rm, dd, kill, claude, ...) only count at command
// position: the start of the command, or right after a shell separator, a
// nested-shell flag (`-c`, `/c`, `-Command`), `-exec` or `xargs`, optionally
// behind a path prefix (`/usr/bin/rm`). A word inside an argument, a string or
// a path (`'dd-mm'`, `C:/tmp/claude/x`) does not trigger them.
const CMD_POSITION_PREFIX = String.raw`(^|.*?([;&|(){}\x60\r\n]|\s-c\s|\s/c\s|\s-Command\s|\s-exec\s|\bxargs(\s+-\S+)*\s))\s*["']?((sudo|doas|env|nohup|exec|time|command)\s+)*([^\s"';&|]*[\\/])?`;
const CMD_POSITION_SUFFIX = String.raw`(\.exe|\.cmd|\.bat|\.ps1|\.sh)?["']?(\s.*)?$`;

export const CMD_DENY_ANYWHERE = Object.freeze({
  delete: String.raw`Remove-Item|Clear-Content|Clear-RecycleBin|shred|rmtree|rimraf`,
  network: String.raw`curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Net\.WebClient`,
  system: String.raw`shutdown|Restart-Computer|Stop-Computer|schtasks|Register-ScheduledTask|Set-ExecutionPolicy|diskpart|Stop-Process|taskkill|Start-Process|winget|choco|launchctl|systemctl|crontab|osascript|mkfs|pkill|killall`,
});

export const CMD_DENY_AT_COMMAND = Object.freeze({
  delete: String.raw`rm|del|erase|rd|ri|rmdir|unlink`,
  network: String.raw`iwr|irm|ssh|scp|sftp|ftp|telnet|nc|ncat|rsync`,
  system: String.raw`sudo|doas|su|chmod|chown|chgrp|dd|mount|umount|kill|reg|format|brew|apt|apt-get|yum|dnf|pacman|snap`,
  agents: String.raw`agy|codex|claude|grok|gemini|opencode|aider|cursor-agent`,
});

export const CMD_DENY_EXTRA = Object.freeze([
  String.raw`.*(@anthropic-ai/claude-code|@google/gemini-cli|@openai/codex).*`,
  String.raw`.*\bgit\s+(push|reset|clean|restore)\b.*`,
  String.raw`.*\b(pip3?\s+install|npm\s+(i|install|add)\s+(.*\s)?(-g|--global)|yarn\s+global\s+add|pnpm\s+(add|install)\s+(.*\s)?(-g|--global))\b.*`,
]);

export function commandDenyBodies() {
  return [
    ...Object.values(CMD_DENY_ANYWHERE).map((names) => String.raw`.*\b(${names})\b.*`),
    ...Object.values(CMD_DENY_AT_COMMAND).map(
      (names) => `${CMD_POSITION_PREFIX}(${names})${CMD_POSITION_SUFFIX}`
    ),
    ...CMD_DENY_EXTRA,
  ];
}

export const CMD_DENY_PATTERNS = Object.freeze(
  commandDenyBodies().map((body) => `regex:(?is)${body}`)
);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class BackendUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isCaseInsensitivePlatform(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

export function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

export function expandHome(p, homeDir = os.homedir()) {
  const s = String(p);
  if (s === '~') return homeDir;
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(homeDir, s.slice(2));
  }
  return s;
}

export function normalizePath(p, platform = process.platform, cwd = process.cwd()) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathMod.resolve(cwd, String(p));
  const parsed = pathMod.parse(resolved);
  if (resolved === parsed.root) {
    return resolved;
  }
  return resolved.replace(/[\\/]+$/, '');
}

export function pathKey(p, platform = process.platform) {
  const normalized = toSlash(p);
  return isCaseInsensitivePlatform(platform) ? normalized.toLowerCase() : normalized;
}

export function isSamePath(a, b, platform = process.platform, cwd = process.cwd()) {
  return (
    pathKey(normalizePath(a, platform, cwd), platform) ===
    pathKey(normalizePath(b, platform, cwd), platform)
  );
}

export function isInside(child, parent, platform = process.platform, cwd = process.cwd()) {
  const c = toSlash(normalizePath(child, platform, cwd));
  const p = toSlash(normalizePath(parent, platform, cwd));
  const cSlash = c.endsWith('/') ? c : `${c}/`;
  const pSlash = p.endsWith('/') ? p : `${p}/`;
  return pathKey(cSlash, platform).startsWith(pathKey(pSlash, platform));
}

export function uniquePaths(paths, platform = process.platform, cwd = process.cwd()) {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    const norm = normalizePath(item, platform, cwd);
    const key = pathKey(norm, platform);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(norm);
    }
  }
  return out;
}

export function splitList(values) {
  const out = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (const part of v.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

export function limitText(text, maxLen) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length > maxLen) {
    return `${collapsed.slice(0, maxLen)}...`;
  }
  return collapsed;
}

export function getStateHome(
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  cwd = process.cwd()
) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const custom = env.BRAIN_DISPATCH_HOME?.trim();
  if (custom) {
    return normalizePath(expandHome(custom, homeDir), platform, cwd);
  }
  return normalizePath(pathMod.join(homeDir, '.brain-dispatch'), platform, homeDir);
}

export function mergeConfig(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const workerRaw = obj.worker && typeof obj.worker === 'object' && !Array.isArray(obj.worker)
    ? obj.worker
    : {};

  return {
    ...obj,
    worker: {
      model:
        typeof workerRaw.model === 'string' && workerRaw.model.trim()
          ? workerRaw.model.trim()
          : DEFAULT_CONFIG.worker.model,
      effort:
        typeof workerRaw.effort === 'string' && workerRaw.effort.trim()
          ? workerRaw.effort.trim()
          : DEFAULT_CONFIG.worker.effort,
      timeoutMin:
        typeof workerRaw.timeoutMin === 'number' &&
        Number.isFinite(workerRaw.timeoutMin) &&
        workerRaw.timeoutMin > 0
          ? workerRaw.timeoutMin
          : DEFAULT_CONFIG.worker.timeoutMin,
    },
    protect: Array.isArray(obj.protect)
      ? obj.protect.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    proxy: typeof obj.proxy === 'string' && obj.proxy.trim() ? obj.proxy.trim() : null,
    agy: typeof obj.agy === 'string' && obj.agy.trim() ? obj.agy.trim() : null,
    policyHook: typeof obj.policyHook === 'boolean' ? obj.policyHook : DEFAULT_CONFIG.policyHook,
  };
}

export function loadConfig(stateHome) {
  const configPath = path.join(stateHome, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { exists: false, path: configPath, config: mergeConfig({}) };
  }
  let parsed;
  try {
    const raw = stripBom(fs.readFileSync(configPath, 'utf8'));
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(`Invalid JSON in config file ${configPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`Config file ${configPath} must contain a JSON object`);
  }
  return { exists: true, path: configPath, config: mergeConfig(parsed) };
}

export function validateName(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]+$/u.test(name)) {
    throw new ValidationError(
      `Invalid --name "${name ?? ''}": only letters, digits, '_' and '-' are allowed`
    );
  }
}

export function parseWorkerArgs(argv, config = mergeConfig({})) {
  const opts = {
    name: null,
    task: null,
    context: null,
    followUp: null,
    workdir: null,
    readDirs: [],
    writeDirs: [],
    protect: [],
    access: 'write',
    effort: config.worker.effort,
    model: null,
    web: false,
    timeoutMin: config.worker.timeoutMin,
    dryRun: false,
    help: false,
  };

  const valueFlags = new Set([
    '--name',
    '--task',
    '--context',
    '--follow-up',
    '--workdir',
    '--read-dir',
    '--write-dir',
    '--protect',
    '--access',
    '--effort',
    '--model',
    '--timeout-min',
  ]);

  const disallowedWithFollowUp = new Set([
    '--workdir',
    '--write-dir',
    '--read-dir',
    '--protect',
    '--access',
    '--web',
    '--model',
    '--effort',
    '--context',
  ]);
  const followUpConflicts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      opts.help = true;
      return opts;
    }
    if (token === '--web') {
      opts.web = true;
      followUpConflicts.push('--web');
      continue;
    }
    if (token === '--dry-run') {
      opts.dryRun = true;
      continue;
    }

    let flag = token;
    let val = null;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0 && token.startsWith('--')) {
      flag = token.slice(0, eqIdx);
      val = token.slice(eqIdx + 1);
    }

    if (!valueFlags.has(flag)) {
      throw new ValidationError(`Unknown or unexpected argument: ${token}`);
    }

    if (val === null) {
      if (i + 1 >= argv.length) {
        throw new ValidationError(`Missing value for ${flag}`);
      }
      val = argv[i + 1];
      i += 1;
    }

    if (disallowedWithFollowUp.has(flag)) {
      followUpConflicts.push(flag);
    }

    switch (flag) {
      case '--name':
        opts.name = val;
        break;
      case '--task':
        opts.task = val;
        break;
      case '--context':
        opts.context = val;
        break;
      case '--follow-up':
        opts.followUp = val;
        break;
      case '--workdir':
        opts.workdir = val;
        break;
      case '--read-dir':
        opts.readDirs.push(val);
        break;
      case '--write-dir':
        opts.writeDirs.push(val);
        break;
      case '--protect':
        opts.protect.push(val);
        break;
      case '--access':
        opts.access = val;
        break;
      case '--effort':
        opts.effort = val;
        break;
      case '--model':
        opts.model = val;
        break;
      case '--timeout-min': {
        const num = Number(val);
        if (!val.trim() || !Number.isFinite(num) || num <= 0) {
          throw new ValidationError(`Invalid --timeout-min "${val}": must be a positive number`);
        }
        opts.timeoutMin = num;
        break;
      }
      default:
        break;
    }
  }

  if (!opts.name) throw new ValidationError('Missing required argument: --name');
  validateName(opts.name);
  if (!opts.task) throw new ValidationError('Missing required argument: --task');

  if (opts.followUp !== null) {
    if (!opts.followUp.trim()) {
      throw new ValidationError('Invalid --follow-up: value cannot be empty');
    }
    if (followUpConflicts.length > 0) {
      throw new ValidationError(
        `--follow-up takes its directories, access level, model and context file from the earlier job; remove ${followUpConflicts[0]}`
      );
    }
    return opts;
  }

  if (!opts.workdir) throw new ValidationError('Missing required argument: --workdir');

  if (!VALID_ACCESS.includes(opts.access)) {
    throw new ValidationError(
      `Invalid --access "${opts.access}": expected one of ${VALID_ACCESS.join(', ')}`
    );
  }
  if (!VALID_EFFORTS.includes(opts.effort)) {
    throw new ValidationError(
      `Invalid --effort "${opts.effort}": expected one of ${VALID_EFFORTS.join(', ')}`
    );
  }
  if (opts.model !== null && !opts.model.trim()) {
    throw new ValidationError('Invalid --model: value cannot be empty');
  }
  if (opts.context !== null && !opts.context.trim()) {
    throw new ValidationError('Invalid --context: value cannot be empty');
  }

  opts.readDirs = splitList(opts.readDirs);
  opts.writeDirs = splitList(opts.writeDirs);
  opts.protect = splitList(opts.protect);
  opts.resolvedModel = opts.model
    ? opts.model.trim()
    : `${config.worker.model}-${opts.effort}`;

  return opts;
}

export function resolveFollowUp({ ref, stateHome, platform = process.platform }) {
  const rawRef = String(ref ?? '');
  const trimmedRef = rawRef.trim();
  const resolvedStateHome = normalizePath(stateHome, platform);
  const jobsDir = normalizePath(path.join(resolvedStateHome, 'jobs'), platform);

  let jobDir = null;
  if (trimmedRef) {
    const candidate = normalizePath(expandHome(rawRef, os.homedir()), platform);
    // A directory counts as a job directory only when it holds a meta.json, so
    // a job name that happens to match a folder in the current directory still
    // resolves by name.
    try {
      if (
        fs.statSync(candidate).isDirectory() &&
        fs.statSync(path.join(candidate, 'meta.json')).isFile()
      ) {
        jobDir = candidate;
      }
    } catch {
      // Not a job directory; fall back to job name lookup under jobsDir.
    }
  }

  if (!jobDir && trimmedRef) {
    let entries = [];
    try {
      entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const suffix = `_${rawRef}`;
    const matches = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix)) continue;
      // The rest must be the time stamp alone, so "fix" does not match a job named "pre_fix".
      if (!/^\d{8}-\d{6}$/.test(entry.name.slice(0, -suffix.length))) continue;
      const fullPath = path.join(jobsDir, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(fullPath).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) {
        matches.push(entry.name);
      }
    }
    if (matches.length > 0) {
      matches.sort();
      jobDir = normalizePath(path.join(jobsDir, matches[matches.length - 1]), platform);
    }
  }

  if (!jobDir) {
    throw new ValidationError(
      `No earlier job found for "${rawRef}" (looked for a job directory, then for a job of that name under ${jobsDir})`
    );
  }

  const metaPath = path.join(jobDir, 'meta.json');
  const noConvMsg = `Job "${rawRef}" has no conversation to continue; dispatch a fresh job instead`;
  let meta;
  try {
    const raw = stripBom(fs.readFileSync(metaPath, 'utf8'));
    meta = JSON.parse(raw);
  } catch {
    throw new ValidationError(noConvMsg);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ValidationError(noConvMsg);
  }
  if (typeof meta.conversation_id !== 'string' || !meta.conversation_id.trim()) {
    throw new ValidationError(noConvMsg);
  }
  if (typeof meta.work_dir !== 'string' || !meta.work_dir.trim()) {
    throw new ValidationError(noConvMsg);
  }
  if (!VALID_ACCESS.includes(meta.access)) {
    throw new ValidationError(noConvMsg);
  }

  const toStringList = (val) =>
    Array.isArray(val) ? val.filter((item) => typeof item === 'string' && item.trim()) : [];

  return {
    jobDir,
    conversationId: meta.conversation_id,
    workDir: meta.work_dir,
    writeDirs: toStringList(meta.write_dir),
    readDirs: toStringList(meta.read_dir),
    access: meta.access,
    web: Boolean(meta.web),
    model: typeof meta.model === 'string' && meta.model.trim() ? meta.model : null,
    contextFile:
      typeof meta.context_file === 'string' && meta.context_file.trim() ? meta.context_file : null,
    protect: toStringList(meta.protect),
  };
}

export function getHardProtectedDirs({
  homeDir = os.homedir(),
  stateHome,
  platform = process.platform,
}) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const relDirs = [
    '.claude',
    '.codex',
    '.gemini',
    '.grok',
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    pathMod.join('.config', 'gh'),
  ];
  const resolvedStateHome = stateHome ?? getStateHome({}, homeDir, platform);
  return uniquePaths(
    [...relDirs.map((rel) => pathMod.join(homeDir, rel)), resolvedStateHome],
    platform,
    homeDir
  );
}

export function validateDirectories({
  workDir,
  writeDirs = [],
  readDirs = [],
  configProtect = [],
  cliProtect = [],
  access = 'write',
  homeDir = os.homedir(),
  stateHome,
  platform = process.platform,
  cwd = process.cwd(),
}) {
  const normWorkDir = normalizePath(expandHome(workDir, homeDir), platform, cwd);
  const normWriteDirs = uniquePaths(
    writeDirs.map((d) => expandHome(d, homeDir)),
    platform,
    cwd
  );
  const normReadDirs = uniquePaths(
    readDirs.map((d) => expandHome(d, homeDir)),
    platform,
    cwd
  );
  const normProtect = uniquePaths(
    [
      ...getHardProtectedDirs({ homeDir, stateHome, platform }),
      ...configProtect.map((d) => expandHome(d, homeDir)),
      ...cliProtect.map((d) => expandHome(d, homeDir)),
    ],
    platform,
    cwd
  );

  const writable =
    access === 'read' ? [] : uniquePaths([normWorkDir, ...normWriteDirs], platform, cwd);

  for (const w of writable) {
    for (const p of normProtect) {
      if (isInside(w, p, platform, cwd)) {
        throw new ValidationError(
          `Protected directory cannot be writable: ${toSlash(w)} (inside ${toSlash(p)})`
        );
      }
    }
    for (const r of normReadDirs) {
      if (isInside(w, r, platform, cwd)) {
        throw new ValidationError(
          `Read-only directory ${toSlash(r)} encloses writable directory ${toSlash(w)}, which would block writes; pass a more specific subdirectory to --read-dir`
        );
      }
    }
  }

  const writeDeny = uniquePaths([...normProtect, ...normReadDirs], platform, cwd);

  return {
    workDir: normWorkDir,
    writeDirs: normWriteDirs,
    readDirs: normReadDirs,
    writable,
    protectedDirs: normProtect,
    writeDeny,
  };
}

// agy evaluates rules strictly as Deny > Ask > Allow, and file access outside
// the workspace defaults to Ask (which print mode has been observed to let
// through). It cannot express "only these directories are writable": a broad
// deny would also beat the narrow allow. So writable directories get explicit
// allows, protected directories get denies, and everything the worker writes
// with its file tools is audited afterwards from the event stream.
export function buildSettings({ access, web, writeDeny = [], writable = [] }) {
  const allow = ['read_file(*)'];
  const deny = ['execute_url(*)'];

  if (web) {
    allow.push('read_url(*)');
    deny.push('mcp(*)');
  } else {
    deny.push('mcp(*)', 'read_url(*)');
  }

  switch (access) {
    case 'read':
      deny.push('write_file(*)', 'command(*)', 'unsandboxed(*)');
      break;
    case 'write':
      for (const dir of writable) {
        allow.push(`write_file(${toSlash(dir)})`);
      }
      deny.push('command(*)', 'unsandboxed(*)');
      for (const dir of writeDeny) {
        deny.push(`write_file(${toSlash(dir)})`);
      }
      break;
    case 'full':
      for (const dir of writable) {
        allow.push(`write_file(${toSlash(dir)})`);
      }
      allow.push('command(*)', 'unsandboxed(*)');
      for (const pattern of CMD_DENY_PATTERNS) {
        deny.push(`command(${pattern})`, `unsandboxed(${pattern})`);
      }
      for (const dir of writeDeny) {
        deny.push(`write_file(${toSlash(dir)})`);
      }
      break;
    default:
      throw new ValidationError(`Unsupported access level: ${access}`);
  }

  return {
    permissions: {
      allow,
      deny,
    },
  };
}

export function renderPrompt({
  template,
  taskText,
  workDir,
  writable,
  readDirs,
  access,
  web,
  contextText = null,
  contextFile = null,
}) {
  const formatBullets = (list, emptyText) =>
    list.length > 0
      ? list.map((dir) => `  - \`${toSlash(dir)}\``).join('\n')
      : `  - ${emptyText}`;

  const cmdTextByAccess = {
    read: 'You cannot run any command.',
    write:
      'You cannot run any command; to process data, read and write files directly. If the job truly cannot be finished without running a script, report `blocked` and say in `open` what needs to run.',
    full:
      'You may run commands, operating only inside the working directory. Install nothing globally. Commands that delete files, download from the network, push or reset git history, change system settings or start another agent are blocked; if one is blocked, find another way or put it in `open`. Do not work around the block.',
  };

  const webText = web
    ? 'You may search the web and read URLs. Attach the link to every piece of information taken from the web.'
    : 'No web access. If you need information from the web, put it in `open`.';

  const trimmedContext = typeof contextText === 'string' ? contextText.trim() : '';
  const sourcePart = contextFile ? ` (source: \`${toSlash(contextFile)}\`)` : '';
  const contextBlock = trimmedContext
    ? [
        '# Shared context',
        '',
        `Background the brain gives to every job in this piece of work${sourcePart}. Treat it as settled. You cannot change this file: if something in it looks wrong or out of date, say so in \`open\`.`,
        '',
        trimmedContext,
        '',
      ].join('\n')
    : '';

  const head = template
    .split('{{WORKDIR}}')
    .join(toSlash(workDir))
    .split('{{WRITABLE}}')
    .join(formatBullets(writable, '(none; this job is read-only)'))
    .split('{{READONLY}}')
    .join(formatBullets(readDirs, '(none listed; everything else on this machine is readable but not writable)'))
    .split('{{CMD}}')
    .join(cmdTextByAccess[access])
    .split('{{WEB}}')
    .join(webText)
    .split('{{CONTEXT}}')
    .join(contextBlock);

  return head + taskText;
}

export function selectPromptArg(prompt, promptFilePath) {
  if (prompt.length > PROMPT_INLINE_LIMIT) {
    return `First read the full brief with your file-read tool at ${toSlash(promptFilePath)}, then follow its protocol and task exactly. If you cannot read it, report blocked.`;
  }
  return prompt;
}

export function buildBackendArgs({
  promptArg,
  model,
  settingsFile,
  schemaFile,
  timeoutMin,
  access,
  conversationId = null,
}) {
  const timeoutSec = Math.max(1, Math.round(timeoutMin * 60));
  // stream-json carries one event per tool call (with its parameters) before the
  // final result, which is what lets the dispatcher audit writes and commands.
  const argv = [
    '-p',
    promptArg,
    '--model',
    model,
    '--settings',
    settingsFile,
    '--output-format',
    'stream-json',
    '--json-schema',
    schemaFile,
    '--print-timeout',
    `${timeoutSec}s`,
    '--disable-slash-commands',
  ];

  if (access !== 'read') {
    argv.push('--mode', 'accept-edits');
  }
  if (conversationId) {
    argv.push('--conversation', conversationId);
  }

  // No --add-dir. agy sorts its workspace directories alphabetically and runs
  // commands in the first one, so any added directory could become the command
  // directory and catch files a script writes with relative paths. Reading
  // outside the workspace works through the read_file(*) rule, and the extra
  // writable directories have their own write_file allows.
  return argv;
}

export function findBackend(
  config = mergeConfig({}),
  env = process.env,
  platform = process.platform,
  fsOps = {}
) {
  const isFile =
    fsOps.isFile ??
    ((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const isExecutable =
    fsOps.isExecutable ??
    ((p) => {
      if (!isFile(p)) return false;
      if (platform === 'win32') return true;
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

  const envCmd = env.BRAIN_DISPATCH_AGY_CMD?.trim();
  if (envCmd) {
    let parsed;
    try {
      parsed = JSON.parse(envCmd);
    } catch (err) {
      throw new BackendUnavailableError(
        `Invalid JSON in BRAIN_DISPATCH_AGY_CMD: ${err.message}`
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      throw new BackendUnavailableError(
        'BRAIN_DISPATCH_AGY_CMD must be a non-empty JSON array of strings'
      );
    }
    return {
      command: parsed[0],
      argsPrefix: parsed.slice(1),
      source: 'env',
    };
  }

  if (config.agy) {
    const candidate = expandHome(config.agy, os.homedir());
    if (isExecutable(candidate)) {
      return {
        command: candidate,
        argsPrefix: [],
        source: 'config',
      };
    }
  }

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const exeName = platform === 'win32' ? 'agy.exe' : 'agy';
  const pathEnv = env.PATH || env.Path || '';
  const pathDirs = pathEnv
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = pathMod.join(dir, exeName);
    if (isExecutable(candidate)) {
      return {
        command: candidate,
        argsPrefix: [],
        source: 'path',
      };
    }
  }

  if (platform === 'win32' && env.LOCALAPPDATA) {
    const fallback = pathMod.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (isExecutable(fallback)) {
      return {
        command: fallback,
        argsPrefix: [],
        source: 'localappdata',
      };
    }
  }

  throw new BackendUnavailableError(
    "Antigravity CLI (agy) not found. Install Antigravity CLI and run 'agy' once to sign in."
  );
}

export function formatJobStamp(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

export function formatLocalIso(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

export function takeSnapshot(dirs, platform = process.platform) {
  const snap = new Map();

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath, { bigint: true });
          const norm = normalizePath(fullPath, platform);
          const key = pathKey(norm, platform);
          snap.set(key, { path: norm, sig: `${st.size}|${st.mtimeNs}` });
        } catch {
          // Ignore unreadable or transient files
        }
      }
    }
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    walk(dir);
  }

  return snap;
}

export function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [key, entry] of after.entries()) {
    const prev = before.get(key);
    if (!prev) {
      created.push(entry.path);
    } else if (prev.sig !== entry.sig) {
      modified.push(entry.path);
    }
  }

  for (const [key, entry] of before.entries()) {
    if (!after.has(key)) {
      deleted.push(entry.path);
    }
  }

  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

export function diffReadOnly(beforeRO, afterRO) {
  const touched = new Map();
  for (const [key, entry] of afterRO.entries()) {
    const prev = beforeRO.get(key);
    if (!prev || prev.sig !== entry.sig) {
      touched.set(key, entry.path);
    }
  }
  for (const [key, entry] of beforeRO.entries()) {
    if (!afterRO.has(key)) {
      touched.set(key, entry.path);
    }
  }
  return [...touched.values()].sort();
}

export function resolveClaimedPath(rawPath, workDir, platform = process.platform) {
  let p = String(rawPath ?? '').trim();
  if (!p) return null;

  if (/^file:\/\//i.test(p)) {
    if (platform === process.platform) {
      try {
        p = fileURLToPath(p);
      } catch {
        p = decodeURIComponent(p.replace(/^file:\/\/\/(?=[a-zA-Z]:)/i, '').replace(/^file:\/\//i, ''));
      }
    } else if (platform === 'win32') {
      p = decodeURIComponent(p.replace(/^file:\/\/\//i, ''));
    } else {
      p = decodeURIComponent(p.replace(/^file:\/\//i, ''));
    }
  }

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  if (!pathMod.isAbsolute(p)) {
    p = pathMod.join(workDir, p);
  }
  return normalizePath(p, platform, workDir);
}

export function reconcileReport({
  report,
  created,
  modified,
  workDir,
  platform = process.platform,
  existsSync = fs.existsSync,
}) {
  const claimed = new Map();
  if (report && Array.isArray(report.files)) {
    for (const item of report.files) {
      if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
      const resolved = resolveClaimedPath(item.path, workDir, platform);
      if (!resolved) continue;
      claimed.set(pathKey(resolved, platform), {
        path: resolved,
        what: typeof item.what === 'string' ? item.what : '',
      });
    }
  }

  const missing = [];
  for (const entry of claimed.values()) {
    if (!existsSync(entry.path)) {
      missing.push(entry.path);
    }
  }
  missing.sort();

  const changed = [...created, ...modified];
  const unreported = changed.filter((p) => !claimed.has(pathKey(p, platform)));

  return { claimed, missing, unreported };
}

export function validateReportSchema(rep) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) {
    return 'report must be a JSON object';
  }
  const requiredKeys = ['status', 'summary', 'files', 'findings', 'verified', 'unverified', 'open'];
  const allowedKeys = new Set(requiredKeys);
  for (const k of Object.keys(rep)) {
    if (!allowedKeys.has(k)) {
      return `unexpected property "${k}"`;
    }
  }
  for (const k of requiredKeys) {
    if (!(k in rep)) {
      return `missing required property "${k}"`;
    }
  }
  if (!['done', 'partial', 'blocked'].includes(rep.status)) {
    return `invalid status "${rep.status}"`;
  }
  if (typeof rep.summary !== 'string') {
    return 'summary must be a string';
  }
  if (!Array.isArray(rep.files)) {
    return 'files must be an array';
  }
  for (let i = 0; i < rep.files.length; i += 1) {
    const f = rep.files[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return `files[${i}] must be an object`;
    }
    const fKeys = Object.keys(f);
    if (fKeys.some((k) => k !== 'path' && k !== 'what')) {
      return `files[${i}] contains unexpected property`;
    }
    if (typeof f.path !== 'string' || typeof f.what !== 'string') {
      return `files[${i}] must have string path and what`;
    }
  }
  for (const arrKey of ['findings', 'verified', 'unverified', 'open']) {
    if (!Array.isArray(rep[arrKey]) || rep[arrKey].some((x) => typeof x !== 'string')) {
      return `${arrKey} must be an array of strings`;
    }
  }
  return null;
}

function parseJsonObject(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Reads agy's stream-json output: an `init` event, one `step_update` event per
// step (tool calls carry `tool_name` and `tool_info.parameters`), and a final
// `result` event shaped like the plain json output. Returns null when the text
// is not an event stream.
export function parseEventStream(text) {
  const events = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('{'))
    .map(parseJsonObject)
    .filter((obj) => obj && typeof obj.event === 'string');
  if (events.length === 0) return null;

  let init = null;
  let result = null;
  const tools = [];
  for (const ev of events) {
    const body = ev[ev.event];
    if (!body || typeof body !== 'object') continue;
    if (ev.event === 'init') {
      init = body;
    } else if (ev.event === 'result') {
      result = body;
    } else if (
      ev.event === 'step_update' &&
      body.tool_name &&
      (body.state === 'DONE' || body.state === 'ERROR')
    ) {
      const info = body.tool_info && typeof body.tool_info === 'object' ? body.tool_info : {};
      tools.push({
        tool: String(body.tool_name),
        state: String(body.state),
        params: info.parameters && typeof info.parameters === 'object' ? info.parameters : {},
        error: info.error && typeof info.error.message === 'string' ? info.error.message : null,
      });
    }
  }
  return { init, result, tools };
}

const WRITE_TOOL = /write|edit|replace|create|delete|remove|move|rename|patch|insert|append|copy|mkdir|save/i;
const READ_ONLY_TOOL = /^(read|view|list|search|find|grep|glob|fetch|get|stat)/i;
const PATH_PARAM = /path|file|target|dest|dir/i;
const NOT_PATH_PARAM = /content|text|body|data|instruction|description|code/i;

// File paths a tool call wrote to (agy's write_file and edit_file take `Path`).
// Commands are not included: what a command writes cannot be seen from its
// parameters.
export function writtenPaths(tools) {
  const out = [];
  for (const call of tools) {
    if (call.state !== 'DONE' || call.tool === 'run_command') continue;
    if (!WRITE_TOOL.test(call.tool) || READ_ONLY_TOOL.test(call.tool)) continue;
    for (const [key, value] of Object.entries(call.params)) {
      if (!PATH_PARAM.test(key) || NOT_PATH_PARAM.test(key)) continue;
      if (typeof value !== 'string') continue;
      const v = value.trim();
      if (v && v.length < 1024 && !/[\r\n]/.test(v)) out.push(v);
    }
  }
  return out;
}

export function commandsRun(tools) {
  return tools
    .filter((call) => call.tool === 'run_command')
    .map((call) => ({
      command: String(call.params.CommandLine ?? call.params.command ?? call.params.Command ?? ''),
      ok: call.state === 'DONE',
    }));
}

export function deniedSteps(tools) {
  return tools
    .filter((call) => call.state === 'ERROR' && call.error && /permission/i.test(call.error))
    .map((call) => limitText(call.error.replace(/^.*?(Permission denied for )/i, '$1'), 240));
}

export function parseBackendOutput(stdout) {
  let rawObj = null;
  const text = String(stdout ?? '');
  const stream = parseEventStream(text);
  if (stream) {
    rawObj = stream.result;
  } else {
    rawObj = parseJsonObject(text);
    if (!rawObj) {
      const lines = text.split(/\r?\n/).filter((line) => line.trimStart().startsWith('{'));
      const last = lines[lines.length - 1];
      if (last) rawObj = parseJsonObject(last);
    }
  }
  const tools = stream ? stream.tools : [];

  const status = rawObj ? (rawObj.status != null ? String(rawObj.status) : '') : 'UNPARSED';
  const usage = rawObj?.usage ?? null;
  const conversationId = rawObj?.conversation_id ?? null;
  const deniedSet = new Set();
  if (Array.isArray(rawObj?.denied_actions)) {
    for (const item of rawObj.denied_actions) {
      if (item && typeof item.action === 'string' && item.action.trim()) {
        deniedSet.add(item.action);
      }
    }
  }
  const denied = [...deniedSet];
  const respText = rawObj?.response != null ? String(rawObj.response) : '';

  let rep = rawObj?.structured_output ?? null;
  if (!rep && respText) {
    const start = respText.indexOf('{');
    const end = respText.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const cand = JSON.parse(respText.slice(start, end + 1));
        if (cand && typeof cand === 'object' && cand.status && cand.summary != null) {
          rep = cand;
        }
      } catch {
        // Ignore non-JSON braces in response text
      }
    }
  }

  const repError = rep ? validateReportSchema(rep) : null;

  return {
    rawObj,
    status,
    usage,
    conversationId,
    denied,
    respText,
    rep,
    repError,
    streamed: Boolean(stream),
    commandDir: stream?.init?.cwd ?? null,
    tools,
    written: writtenPaths(tools),
    commands: commandsRun(tools),
    deniedSteps: deniedSteps(tools),
  };
}

// Paths the worker wrote with its file tools that are outside every writable
// directory. agy does not block these; the dispatcher reports them.
export function writesOutside({ written, writable, workDir, platform = process.platform }) {
  const outside = new Map();
  for (const raw of written) {
    const resolved = resolveClaimedPath(raw, workDir, platform);
    if (!resolved) continue;
    if (!writable.some((dir) => isInside(resolved, dir, platform))) {
      outside.set(pathKey(resolved, platform), resolved);
    }
  }
  return [...outside.values()].sort();
}

export function judgeRun({
  timedOut,
  timeoutMin,
  code,
  stderr,
  stdout,
  parsed,
  missing = [],
  roTouched = [],
  contextChanged = false,
  outside = [],
  elapsedSec = null,
  expectedConversationId = null,
}) {
  const errLines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errHead = errLines.slice(0, 3).join(' / ');
  const combined = `${stderr ?? ''}\n${stdout ?? ''}`;
  const validRep = parsed.rep && !parsed.repError ? parsed.rep : null;

  if (timedOut) {
    return { exit: 4, reason: `Timed out (${timeoutMin} min)` };
  }
  if (/authentication required|not logged in|login required/i.test(stderr ?? '')) {
    return {
      exit: 5,
      reason: "agy not signed in or session expired: run 'agy' in a terminal to sign in",
    };
  }
  if (!validRep && /quota|RESOURCE_EXHAUSTED|rate.?limit|\b429\b/i.test(combined)) {
    return {
      exit: 5,
      reason: `Worker quota exhausted or rate-limited: ${limitText(errHead, 200)}`,
    };
  }
  // The backend's own --print-timeout ends the turn with a partial reply and exit
  // code 0. Without a report, a run that used up its time limit is a timeout.
  const limitSec = timeoutMin * 60;
  if (
    !validRep &&
    typeof elapsedSec === 'number' &&
    elapsedSec >= Math.max(limitSec - 2, limitSec * 0.95)
  ) {
    return {
      exit: 4,
      reason: `Time limit reached (${timeoutMin} min) before a report was produced; files finished so far are listed under Files`,
    };
  }
  if (!parsed.rawObj) {
    return {
      exit: 3,
      reason: `Backend did not return JSON (exit=${code}): ${limitText(errHead, 200)}`,
    };
  }
  if (expectedConversationId && parsed.conversationId !== expectedConversationId) {
    return {
      exit: 3,
      reason:
        'Follow-up did not resume the earlier conversation (the backend started a new one, without the protocol); dispatch a fresh job',
    };
  }
  if (!validRep && parsed.denied.length > 0) {
    return {
      exit: 3,
      reason: `Aborted due to denied action (${parsed.denied.join(', ')}); headless mode rejected the unpermitted operation and ended the run (written files were kept). Check if the task tried to write outside writable dirs or needs higher --access`,
    };
  }
  if (parsed.status !== 'SUCCESS' && !validRep) {
    return {
      exit: 3,
      reason: `Backend failed: exit=${code} status=${parsed.status} ${limitText(errHead, 200)}`,
    };
  }
  if (!parsed.rep) {
    return {
      exit: 3,
      reason: 'No structured report returned (raw response saved in report.md)',
    };
  }
  if (parsed.repError) {
    return {
      exit: 3,
      reason: `Invalid report format: ${parsed.repError}`,
    };
  }
  if (validRep.status === 'blocked') {
    return {
      exit: 3,
      reason: `Worker reported blocked: ${limitText(String(validRep.summary), 200)}`,
    };
  }
  if (missing.length > 0) {
    return {
      exit: 3,
      reason: `Reconciliation mismatch: ${missing.length} reported file(s) do not exist (likely wrong path or never written)`,
    };
  }
  if (roTouched.length > 0) {
    return {
      exit: 3,
      reason: `Read-only directory modified: ${roTouched.length} file(s) touched`,
    };
  }
  if (contextChanged) {
    return {
      exit: 3,
      reason: 'Shared context file was modified during the run',
    };
  }
  if (outside.length > 0) {
    return {
      exit: 3,
      reason: `Wrote ${outside.length} file(s) outside the writable directories (see !! lines)`,
    };
  }
  return { exit: 0, reason: null };
}

export function formatFileSize(bytes) {
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function formatReport({
  name,
  model,
  access,
  secs,
  reason,
  parsed,
  created,
  modified,
  deleted,
  missing,
  unreported,
  roTouched,
  contextChanged = false,
  contextFile = null,
  outside = [],
  claimed,
  platform = process.platform,
  statSync = fs.statSync,
}) {
  const rep = parsed.rep && !parsed.repError ? parsed.rep : null;
  const label = !rep ? 'no-report' : String(rep.status);
  const totalTokens = parsed.usage?.total_tokens;
  const tok =
    typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0
      ? totalTokens.toLocaleString('en-US')
      : '?';

  const formatEntry = (filePath) => {
    let sizeStr = '';
    try {
      const st = statSync(filePath);
      sizeStr = formatFileSize(Number(st.size));
    } catch {
      sizeStr = '';
    }
    const what = claimed.get(pathKey(filePath, platform))?.what;
    return `${filePath}${sizeStr ? `  ${sizeStr}` : ''}${what ? `  -- ${what}` : ''}`;
  };

  const lines = [];
  lines.push(`WORKER ${name} | ${label} | ${model} | ${access} | ${secs}s | tokens ${tok}`);
  if (reason) {
    lines.push(`REJECTED: ${reason}`);
  }
  if (rep) {
    lines.push(`Summary: ${rep.summary}`);
  }

  const hasChanges =
    created.length +
      modified.length +
      deleted.length +
      missing.length +
      roTouched.length +
      outside.length >
      0 || Boolean(contextChanged);
  lines.push(`Files (measured by the dispatcher):${hasChanges ? '' : ' no changes'}`);
  for (const f of created) lines.push(`  + ${formatEntry(f)}`);
  for (const f of modified) lines.push(`  ~ ${formatEntry(f)}`);
  for (const f of deleted) lines.push(`  - deleted: ${f}`);
  for (const f of missing) lines.push(`  ! reported but missing: ${f}`);
  for (const f of unreported) lines.push(`  ? changed but not reported: ${f}`);
  for (const f of roTouched) lines.push(`  !! read-only dir touched: ${f}`);
  if (contextChanged) lines.push(`  !! shared context modified: ${contextFile ?? '(unknown)'}`);
  for (const f of outside) lines.push(`  !! written outside writable dirs: ${f}`);

  const denied = Array.isArray(parsed.deniedSteps) ? parsed.deniedSteps : [];
  if (denied.length > 0) {
    lines.push('Denied by the permission rules:');
    for (const d of denied.slice(0, 10)) lines.push(`  x ${d}`);
    if (denied.length > 10) lines.push(`  ... ${denied.length - 10} more`);
  }
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  if (access === 'full' && commands.length > 0) {
    lines.push('Commands run (not audited for file writes):');
    for (const c of commands.slice(0, 15)) {
      lines.push(`  ${c.ok ? '$' : 'x'} ${limitText(String(c.command ?? ''), 200)}`);
    }
    if (commands.length > 15) lines.push(`  ... ${commands.length - 15} more`);
  }

  const pushSection = (title, items) => {
    const clean = Array.isArray(items)
      ? items.map((x) => String(x ?? '').trim()).filter(Boolean)
      : [];
    if (clean.length > 0) {
      lines.push(`${title}:`);
      clean.forEach((item, idx) => {
        lines.push(`  ${idx + 1}. ${item}`);
      });
    } else {
      lines.push(`${title}: none`);
    }
  };

  if (rep) {
    pushSection('Findings', rep.findings);
    pushSection('Verified', rep.verified);
    pushSection('Unverified', rep.unverified);
    pushSection('Open', rep.open);
  } else if (parsed.respText.trim()) {
    lines.push('Raw response:');
    lines.push(parsed.respText.trim());
  }

  return {
    lines,
    reportText: `${lines.join('\n')}\n`,
  };
}

export function formatShortOutput(lines, reportMdPath) {
  const truncated = lines.map((line) =>
    line.length > 400 ? `${line.slice(0, 400)}...` : line
  );
  const capped =
    truncated.length > 60
      ? [
          ...truncated.slice(0, 60),
          `... (${lines.length} lines total; see report.md)`,
        ]
      : truncated;
  capped.push(`Full report: ${reportMdPath}`);
  return `${capped.join('\n')}\n`;
}

export function computeRoles({ backendStatus, modelStatus, configuredModel }) {
  if (backendStatus !== 'OK') {
    return {
      worker: {
        status: 'unavailable',
        detail: 'not available; backup-worker (Sonnet) takes its jobs',
      },
      next: 'install the Antigravity CLI (see /brain-dispatch:setup), or carry on with the Claude-only roles.',
    };
  }
  if (modelStatus !== 'OK') {
    return {
      worker: {
        status: 'check-model',
        detail: `agy found, but ${configuredModel} is not in "agy models"`,
      },
      next: 'pick a model from "agy models" and set worker.model in the config.',
    };
  }
  return {
    worker: {
      status: 'ready',
      detail: `ready (${configuredModel})`,
    },
    next: 'run the smoke test in /brain-dispatch:setup to confirm agy is signed in.',
  };
}

export function getRepoRoot() {
  return normalizePath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
}
