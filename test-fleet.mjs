import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = path.join(root, '.testbus');
const cli = path.join(root, 'fleet.mjs');
assert.equal(path.dirname(home), root);
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home);

function runWithRoot(fleetRoot, ...args) {
  const env = { ...process.env, FLEET_HOME: home };
  if (fleetRoot === null) delete env.FLEET_ROOT;
  else env.FLEET_ROOT = fleetRoot;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env,
    encoding: 'utf8', input: '',
  });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result;
}
const run = (...args) => runWithRoot(root, ...args);
const folder = (lane, kind) => path.join(home, lane, kind);
const pending = (lane) => fs.readdirSync(folder(lane, 'inbox')).filter((f) => f.endsWith('.json'));
const done = (lane) => fs.readdirSync(folder(lane, 'done')).filter((f) => f.endsWith('.json'));
const stamp = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
function put(lane, id, type, hoursAgo, withTs = true) {
  const msg = { id, from: 'fixture', to: lane, type, subject: id, body: id };
  if (withTs) msg.ts = stamp(hoursAgo);
  const file = path.join(folder(lane, 'inbox'), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(msg));
  if (!withTs) fs.utimesSync(file, new Date(stamp(hoursAgo)), new Date(stamp(hoursAgo)));
  return file;
}
function monitor(lane) {
  fs.writeFileSync(path.join(home, lane, '.listening'), JSON.stringify({ mode: 'monitor', ts: new Date().toISOString() }));
}

try {
  for (const lane of ['alice', 'bob', 'carol', 'dana']) run('init', '--lane', lane);
  fs.writeFileSync(path.join(home, 'alice', '.seen'), stamp(5));
  fs.writeFileSync(path.join(home, 'bob', '.seen'), stamp(1));
  fs.writeFileSync(path.join(home, 'carol', '.seen'), stamp(50));
  fs.unlinkSync(path.join(home, 'dana', '.seen'));
  monitor('alice');
  const rows = run('lanes').stdout.trim().split('\n');
  assert.match(rows[0], /^alice\tONLINE\tlast seen 5h\t0 pending$/);
  assert.match(rows[1], /^bob\tOFFLINE\tlast seen 1h\t0 pending$/);
  assert.match(rows[2], /^carol\tOFFLINE\tlast seen 2d\t0 pending$/);
  assert.match(rows[3], /^dana\tOFFLINE\tlast seen never\t0 pending$/);
  console.log('PASS lanes: online first, recent offline next, last seen and pending');

  const direct = run('send', '--to', 'carol', '--from', 'alice', '--type', 'task', '--body', 'queued');
  assert.match(direct.stderr, /^FLEET: carol is OFFLINE \(last seen 2d\) — message queued\n$/);
  assert.equal(pending('carol').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder('carol', 'inbox'), pending('carol')[0]))).body, 'queued');
  console.log('PASS direct send: offline warning and delivery');

  monitor('bob');
  const broadcast = run('send', '--to', 'online', '--from', 'alice', '--type', 'note', '--body', 'live');
  assert.match(broadcast.stdout, /^sent -> bob id=.+\n$/);
  assert.equal(broadcast.stderr, '');
  assert.equal(pending('bob').length, 1);
  assert.equal(pending('alice').length, 0);
  assert.equal(pending('carol').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder('bob', 'inbox'), pending('bob')[0]))).to, 'bob');
  console.log('PASS online broadcast: online recipients only, sender excluded');

  for (const type of ['note', 'report']) put('alice', `old-${type}`, type, 30);
  put('alice', 'old-ack', 'ack', 30, false); // mtime fallback when ts is absent
  for (const type of ['task', 'correction', 'gate', 'blocked']) put('alice', `old-${type}`, type, 30);
  put('alice', 'fresh-note', 'note', 1);
  const poll = run('poll', '--lane', 'alice');
  assert.match(poll.stdout, /FLEET: archived 3 expired message\(s\) older than 24h \(notes\/reports\)\./);
  assert.equal(pending('alice').length, 5); // four durable types plus the fresh note
  for (const type of ['note', 'report', 'ack']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder('alice', 'done'), `old-${type}.json`))).expired, true);
  }
  for (const type of ['task', 'correction', 'gate', 'blocked']) {
    assert.match(poll.stdout, new RegExp(`\\[${type}\\] old-${type} \\[OLD 1d — confirm it still applies against the current rules before acting\\]`));
  }
  assert.match(poll.stdout, /\[note\] fresh-note/);
  assert.doesNotMatch(poll.stdout, /\[note\] fresh-note \[OLD/);
  put('alice', 'old-json-report', 'report', 30);
  const jsonPoll = run('poll', '--lane', 'alice', '--json');
  assert.equal(JSON.parse(jsonPoll.stdout).length, 5);
  assert.match(jsonPoll.stderr, /archived 1 expired message/);
  assert.ok(fs.existsSync(path.join(home, 'alice', '.seen')));
  console.log('PASS poll expiry: note/report/ack archived, mtime fallback, OLD marker, fresh and JSON preserved');

  put('carol', 'sweep-old-task', 'task', 30);
  put('carol', 'sweep-old-note', 'note', 30);
  put('dana', 'sweep-old-correction', 'correction', 30);
  put('dana', 'sweep-fresh-note', 'note', 1);
  put('bob', 'sweep-online-old-note', 'note', 30);
  const before = ['bob', 'carol', 'dana'].map((lane) => pending(lane).join(','));
  const dry = run('sweep');
  assert.match(dry.stdout, /carol\t2 expired pending/);
  assert.match(dry.stdout, /dana\t1 expired pending/);
  assert.match(dry.stdout, /total: 3 expired pending \(dry run\)/);
  assert.deepEqual(['bob', 'carol', 'dana'].map((lane) => pending(lane).join(',')), before);
  assert.ok(fs.existsSync(path.join(home, 'bob', '.listening')));
  const applied = run('sweep', '--apply');
  assert.match(applied.stdout, /total: 3 expired pending swept/);
  for (const [lane, id] of [['carol', 'sweep-old-task'], ['carol', 'sweep-old-note'], ['dana', 'sweep-old-correction']]) {
    const msg = JSON.parse(fs.readFileSync(path.join(folder(lane, 'done'), `${id}.json`)));
    assert.equal(msg.expired, true);
    assert.ok(Number.isFinite(Date.parse(msg.sweptAt)));
  }
  assert.equal(pending('carol').length, 1); // fresh direct send remains
  assert.deepEqual(pending('dana'), ['sweep-fresh-note.json']);
  assert.ok(pending('bob').includes('sweep-online-old-note.json'));
  assert.deepEqual(done('bob'), []);
  console.log('PASS sweep: dry run unchanged; apply archives only old offline messages');

  run('init', '--lane', 'hook-lane');
  put('hook-lane', 'hook-old-note', 'note', 30);
  assert.match(run('sessionstart', '--cwd', path.join(root, 'hook-lane')).stdout, /archived 1 expired message/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder('hook-lane', 'done'), 'hook-old-note.json'))).expired, true);
  put('hook-lane', 'hook-old-ack', 'ack', 30);
  assert.match(run('ensure', '--cwd', path.join(root, 'hook-lane')).stdout, /archived 1 expired message/);
  assert.equal(pending('hook-lane').length, 0);
  assert.ok(fs.existsSync(path.join(home, 'hook-lane', '.seen')));
  console.log('PASS resume hooks: sessionstart and ensure archive expired inbox items');

  run('register', '--lane', 'alice', '--cwd', root);
  assert.equal(run('whoami', '--cwd', root).stdout.trim(), 'alice');
  const id = pending('carol')[0].slice(0, -5);
  const read = run('read', '--lane', 'carol', '--id', id);
  assert.equal(JSON.parse(read.stdout).body, 'queued');
  assert.match(run('poll', '--lane', 'carol').stdout, /1 pending for carol/);
  run('done', '--lane', 'carol', '--id', id);
  assert.equal(pending('carol').length, 0);
  assert.ok(done('carol').includes(`${id}.json`));
  fs.unlinkSync(path.join(home, 'alice', '.listening'));
  fs.unlinkSync(path.join(home, 'bob', '.listening'));
  assert.equal(run('send', '--to', 'online', '--from', 'alice', '--type', 'note', '--body', 'none').stdout, 'no online lanes\n');
  console.log('PASS original commands: init, send, poll, read, done, whoami');

  run('init', '--lane', 'wait-lane');
  fs.writeFileSync(path.join(home, 'wait-lane', '.seen'), stamp(30));
  assert.match(run('wait', '--lane', 'wait-lane', '--interval', '1', '--timeout', '0.1').stdout, /quiet 0m on wait-lane/);
  assert.ok(Date.now() - Date.parse(fs.readFileSync(path.join(home, 'wait-lane', '.seen'), 'utf8')) < 5000);
  console.log('PASS wait: heartbeat refreshes presence and exits on timeout');

  const unregistered = path.join(root, 'unregistered-lane');
  for (const hook of ['sessionstart', 'ensure', 'settle']) {
    assert.equal(runWithRoot(null, hook, '--cwd', unregistered).stdout, '');
  }
  assert.match(runWithRoot(null, 'poll', '--lane', 'alice').stdout, /pending for alice/);
  runWithRoot(null, 'register', '--lane', 'manual-lane', '--cwd', unregistered);
  assert.match(runWithRoot(null, 'ensure', '--cwd', unregistered).stdout, /lane "manual-lane" listener is DOWN/);
  console.log('PASS no root: unregistered hooks silent; explicit lanes and registration work');

  const fileRoot = path.join(home, 'from-file');
  fs.mkdirSync(fileRoot);
  fs.writeFileSync(path.join(home, '.fleet-root'), `\n  \n${fileRoot}\n${path.join(root, 'ignored')}\n`);
  assert.match(runWithRoot(null, 'sessionstart', '--cwd', path.join(fileRoot, 'file-lane')).stdout, /FLEET lane: file-lane/);
  console.log('PASS root file: first non-empty line auto-arms');

  const envRoot = path.join(home, 'from-env');
  fs.mkdirSync(envRoot);
  assert.equal(runWithRoot(envRoot, 'sessionstart', '--cwd', path.join(fileRoot, 'excluded-lane')).stdout, '');
  assert.match(runWithRoot(envRoot, 'sessionstart', '--cwd', path.join(envRoot, 'env-lane')).stdout, /FLEET lane: env-lane/);
  console.log('PASS env root: FLEET_ROOT overrides .fleet-root');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
