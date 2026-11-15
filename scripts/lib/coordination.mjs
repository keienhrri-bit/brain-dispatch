import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ValidationError, formatJobStamp, isInside } from './core.mjs';

// A unique directory is also the immutable identity of one attempt. Names alone
// are labels: two launches in one second must never overwrite each other's logs.
export function createJobDirectory(stateHome, name, date = new Date()) {
  const jobs = path.join(stateHome, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const suffix = `${String(date.getMilliseconds()).padStart(3, '0')}-${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(jobs, `${formatJobStamp(date)}-${suffix}_${name}`);
  fs.mkdirSync(dir);
  return dir;
}

// Publish complete JSON records in one rename so unrelated concurrent jobs do
// not observe half-written history. This is not a crash-durability guarantee.
export function writeJobJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function leasesConflict(left, right, platform = process.platform) {
  if (left.conversationId && left.conversationId === right.conversationId) return true;
  const overlaps = (a, b) => isInside(a, b, platform) || isInside(b, a, platform);
  return left.writes.some((w) => [...right.writes, ...right.reads].some((r) => overlaps(w, r))) ||
    right.writes.some((w) => left.reads.some((r) => overlaps(w, r)));
}

// The registry is local to BRAIN_DISPATCH_HOME. It is coordination, not an OS
// sandbox. Never steal an orphaned lease: a child backend may still be running.
export async function acquireLease({ stateHome, jobDir, conversationId = null, reads = [], writes = [] }) {
  const mine = {
    pid: process.pid,
    jobDir,
    conversationId,
    started: new Date().toISOString(),
    reads: reads.map(canonicalPath),
    writes: writes.map(canonicalPath),
  };
  const registry = path.join(stateHome, 'active');
  fs.mkdirSync(registry, { recursive: true });
  const mutex = path.join(registry, '.registration');
  let locked = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      fs.mkdirSync(mutex);
      locked = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await delay(25);
    }
  }
  if (!locked) {
    throw new ValidationError(`Coordination registry busy: ${mutex}. Check running dispatchers before clearing an orphaned lock.`);
  }
  const recordPath = path.join(registry, `${crypto.randomUUID()}.json`);
  try {
    for (const entry of fs.readdirSync(registry, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      const file = path.join(registry, entry.name);
      let other;
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular file');
        other = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(other.reads) || !Array.isArray(other.writes) ||
          [...other.reads, ...other.writes].some((p) => typeof p !== 'string')) throw new Error('invalid lease');
      } catch (err) {
        // The owner can finish and unlink its record while we inspect it.
        if (err.code === 'ENOENT') continue;
        throw new ValidationError(`Unreadable active lease: ${file}. Inspect it before dispatching.`);
      }
      if (leasesConflict(mine, other)) {
        throw new ValidationError(`Conflicting active job: ${other.jobDir ?? file} (PID ${other.pid ?? '?'}). Wait for it to finish; orphaned leases require checking the backend before removal: ${file}`);
      }
    }
    fs.writeFileSync(recordPath, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
  } finally {
    fs.rmdirSync(mutex);
  }
  let released = false;
  return () => {
    if (released) return;
    try {
      fs.unlinkSync(recordPath);
      released = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      released = true;
    }
  };
}

function readOptionalJson(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('symbolic link');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ValidationError(`Cannot verify continuation history: ${file} (${err.message})`);
  }
}

export function inspectContinuation({ stateHome, followUp, maxFollowUps = 2, maxReportedTokens = null }) {
  const root = path.join(stateHome, 'jobs');
  const parent = readOptionalJson(path.join(followUp.jobDir, 'meta.json'));
  if (!parent || parent.ok !== true || parent.exit !== 0 || !['done', 'partial'].includes(parent.report_status)) {
    throw new ValidationError('Only an accepted done/partial job can be continued; dispatch a fresh, narrower job after a rejected or interrupted run.');
  }
  if (!isInside(canonicalPath(followUp.jobDir), canonicalPath(root))) {
    throw new ValidationError('Follow-up must belong to this BRAIN_DISPATCH_HOME so its attempts can be counted.');
  }
  let followUps = 0;
  let reportedTokens = 0;
  let unknownUsage = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const attempt = readOptionalJson(path.join(dir, 'attempt.json'));
    const meta = readOptionalJson(path.join(dir, 'meta.json'));
    const requested = attempt?.conversation_id === followUp.conversationId;
    if (!requested && meta?.conversation_id !== followUp.conversationId) continue;
    if (requested || meta?.follow_up_of) followUps += 1;
    if (!meta || meta.ok !== true || meta.exit !== 0) {
      throw new ValidationError(`Conversation has a rejected or unfinished attempt: ${dir}. Review its files and start a fresh job.`);
    }
    const tokens = meta.usage?.total_tokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) reportedTokens += tokens;
    else unknownUsage += 1;
  }
  if (followUps >= maxFollowUps) {
    throw new ValidationError(`Follow-up limit reached (${followUps}/${maxFollowUps}); review the result and start a fresh, narrower job or finish it directly.`);
  }
  if (maxReportedTokens !== null) {
    if (unknownUsage) throw new ValidationError('Cannot enforce maxReportedTokens: earlier conversation usage is unknown. Review usage before starting a fresh job.');
    if (reportedTokens >= maxReportedTokens) {
      throw new ValidationError(`Reported-token threshold reached (${reportedTokens}/${maxReportedTokens}); no further follow-up was started.`);
    }
  }
  return { followUps, reportedTokens, unknownUsage, maxFollowUps, maxReportedTokens };
}
