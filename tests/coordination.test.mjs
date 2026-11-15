import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireLease, createJobDirectory, inspectContinuation } from '../scripts/lib/coordination.mjs';
import { mergeConfig, resolveFollowUp, writesOutside, validateDirectories, parseWorkerArgs } from '../scripts/lib/core.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-coord-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateHome = path.join(root, 'state');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(workDir);
  return { root, stateHome, workDir };
}

function record(stateHome, name, changes = {}, attempt = null) {
  const jobDir = createJobDirectory(stateHome, name);
  const meta = { name, model: 'fake', work_dir: path.join(stateHome, '..', 'work'), access: 'write',
    ok: true, exit: 0, report_status: 'done', conversation_id: 'conv-1', usage: { total_tokens: 100 }, ...changes };
  fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(meta));
  if (attempt) fs.writeFileSync(path.join(jobDir, 'attempt.json'), JSON.stringify(attempt));
  return jobDir;
}

test('same-second same-name jobs retain separate artifacts and resolve by name', (t) => {
  const { stateHome } = fixture(t);
  const date = new Date('2026-11-15T00:00:00.000Z');
  const a = createJobDirectory(stateHome, 'same', date);
  const b = createJobDirectory(stateHome, 'same', date);
  assert.notEqual(a, b);
  for (const dir of [a, b]) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ conversation_id: 'x', work_dir: dir, access: 'read' }));
  assert.ok([a, b].includes(resolveFollowUp({ ref: 'same', stateHome }).jobDir));
});

test('leases reject overlapping writers and readers, while independent jobs remain parallel', async (t) => {
  const { root, stateHome, workDir } = fixture(t);
  const release = await acquireLease({ stateHome, jobDir: 'writer', writes: [workDir] });
  await assert.rejects(acquireLease({ stateHome, jobDir: 'child', writes: [path.join(workDir, 'child')] }), /Conflicting active job/);
  await assert.rejects(acquireLease({ stateHome, jobDir: 'parent', writes: [root] }), /Conflicting active job/);
  await assert.rejects(acquireLease({ stateHome, jobDir: 'reader', reads: [workDir] }), /Conflicting active job/);
  const independent = await acquireLease({ stateHome, jobDir: 'other', writes: [path.join(root, 'other')] });
  independent();
  release();
  const r1 = await acquireLease({ stateHome, jobDir: 'r1', reads: [workDir] });
  const r2 = await acquireLease({ stateHome, jobDir: 'r2', reads: [workDir] });
  r1(); r2();
  assert.deepEqual(fs.readdirSync(path.join(stateHome, 'active')), []);
});

test('simultaneous conflicting registrations admit exactly one job', async (t) => {
  const { stateHome, workDir } = fixture(t);
  const results = await Promise.allSettled([1, 2].map((n) => acquireLease({ stateHome, jobDir: `j${n}`, writes: [workDir] })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  for (const r of results) if (r.status === 'fulfilled') r.value();
});

test('the same conversation is exclusive even with disjoint read-only directories', async (t) => {
  const { stateHome } = fixture(t);
  const release = await acquireLease({ stateHome, jobDir: 'j1', conversationId: 'same' });
  await assert.rejects(acquireLease({ stateHome, jobDir: 'j2', conversationId: 'same' }), /Conflicting active job/);
  release();
});

test('leases canonicalize symlink aliases and never steal orphaned or corrupt records', async (t) => {
  const { root, stateHome, workDir } = fixture(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(workDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const release = await acquireLease({ stateHome, jobDir: 'j1', writes: [workDir] });
  await assert.rejects(acquireLease({ stateHome, jobDir: 'alias', writes: [path.join(alias, 'child')] }), /Conflicting active job/);
  release();
  const stale = path.join(stateHome, 'active', 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ pid: 99999999, jobDir: 'orphan', reads: [], writes: [workDir] }));
  await assert.rejects(acquireLease({ stateHome, jobDir: 'j2', writes: [workDir] }), /orphan/);
  fs.writeFileSync(stale, '{broken');
  await assert.rejects(acquireLease({ stateHome, jobDir: 'j3' }), /Unreadable active lease/);
});

test('continuation limits count sibling follow-ups, not just parent depth', (t) => {
  const { stateHome } = fixture(t);
  const parent = record(stateHome, 'root');
  const followUp = resolveFollowUp({ ref: parent, stateHome });
  assert.equal(inspectContinuation({ stateHome, followUp }).followUps, 0);
  record(stateHome, 'a', { follow_up_of: parent });
  assert.equal(inspectContinuation({ stateHome, followUp }).followUps, 1);
  record(stateHome, 'b', { follow_up_of: parent });
  assert.throws(() => inspectContinuation({ stateHome, followUp }), /Follow-up limit reached \(2\/2\)/);
});

test('continuation thresholds include reported usage and refuse unknown usage', (t) => {
  const { stateHome } = fixture(t);
  const parent = record(stateHome, 'root');
  const followUp = resolveFollowUp({ ref: parent, stateHome });
  assert.throws(() => inspectContinuation({ stateHome, followUp, maxReportedTokens: 100 }), /threshold reached/);
  assert.equal(inspectContinuation({ stateHome, followUp, maxReportedTokens: 101 }).reportedTokens, 100);
  record(stateHome, 'unknown', { follow_up_of: parent, usage: null });
  assert.throws(() => inspectContinuation({ stateHome, followUp, maxReportedTokens: 1000 }), /usage is unknown/);
  assert.equal(inspectContinuation({ stateHome, followUp }).unknownUsage, 1);
});

test('failed and unfinished attempts cannot be resumed through an older parent', (t) => {
  const { stateHome } = fixture(t);
  const parent = record(stateHome, 'root');
  const followUp = resolveFollowUp({ ref: parent, stateHome });
  const failed = record(stateHome, 'failed', { conversation_id: 'unexpected-new', ok: false, exit: 3 }, { conversation_id: 'conv-1' });
  assert.throws(() => inspectContinuation({ stateHome, followUp }), /rejected or unfinished/);
  assert.throws(() => inspectContinuation({ stateHome, followUp: resolveFollowUp({ ref: failed, stateHome }) }), /Only an accepted/);
  fs.unlinkSync(path.join(failed, 'meta.json'));
  assert.throws(() => inspectContinuation({ stateHome, followUp }), /rejected or unfinished/);
});

test('history corruption and cross-state continuation fail closed', (t) => {
  const { root, stateHome } = fixture(t);
  const parent = record(stateHome, 'root');
  const followUp = resolveFollowUp({ ref: parent, stateHome });
  const corrupt = createJobDirectory(stateHome, 'corrupt');
  fs.writeFileSync(path.join(corrupt, 'meta.json'), '{broken');
  assert.throws(() => inspectContinuation({ stateHome, followUp }), /Cannot verify continuation history/);
  const other = path.join(root, 'other');
  record(other, 'seed');
  assert.throws(() => inspectContinuation({ stateHome: other, followUp }), /this BRAIN_DISPATCH_HOME/);
});

test('coordination config validates boundaries instead of silently disabling limits', () => {
  assert.equal(mergeConfig({}).worker.maxFollowUps, 2);
  assert.equal(mergeConfig({ worker: { maxFollowUps: 0 } }).worker.maxFollowUps, 0);
  for (const value of [-1, 1.5, '2', null]) assert.throws(() => mergeConfig({ worker: { maxFollowUps: value } }), /maxFollowUps/);
  for (const value of [-1, 0, 1.5, '100']) assert.throws(() => mergeConfig({ worker: { maxReportedTokens: value } }), /maxReportedTokens/);
});

test('tool-write audit respects denied descendants of a writable directory', () => {
  assert.deepEqual(writesOutside({ written: ['/work/locked/data.txt'], writable: ['/work'], writeDeny: ['/work/locked'], workDir: '/work', platform: 'linux' }), ['/work/locked/data.txt']);
});

test('state nested in a watched directory is rejected before it can invalidate its own audit', () => {
  for (const access of ['read', 'write', 'full']) {
    assert.throws(() => validateDirectories({ workDir: '/work', stateHome: '/work/state', homeDir: '/home/test', access, platform: 'linux', cwd: '/' }), /outside directories being audited/);
  }
  assert.throws(() => validateDirectories({ workDir: '/work', readDirs: ['/data'], stateHome: '/data/state', homeDir: '/home/test', platform: 'linux', cwd: '/' }), /outside directories being audited/);
  assert.throws(() => parseWorkerArgs(['--name', 'x', '--task', '--workdir', 'x']), /Missing value for --task/);
});
