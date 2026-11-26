const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { jobs } = require('../electron/jobs.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const record = { id: randomUUID(), attempt: randomUUID(), name: 'Sample', device: 'paired' };
  await fs.writeFile(path.join(dir, 'attempt.json'), JSON.stringify(record));
  const actions = [];
  function open(handler, device = 'paired') {
    return jobs(
      dir,
      () => device,
      'unused',
      async (action, id, attempt) => {
        assert.equal(id, record.id);
        assert.equal(attempt, record.attempt);
        actions.push(action);
        return handler(action);
      },
      () => {},
      () => false,
    );
  }
  return { dir, record, actions, open, output: path.join(dir, record.attempt + '.zip') };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for job recovery');
}

test('restart preserves a finished archive and a lost upload acknowledgment does not duplicate it', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('finished result');
  await fs.writeFile(f.output, bytes);
  let stored = false,
    puts = 0;
  const storage = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    stored = true;
    puts++;
    res.writeHead(503);
    res.end();
  });
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve));
  t.after(() => storage.close());
  const work = f.open((action) => {
    if (action === 'reconcile') return { status: 'running', uploaded: stored };
    if (action === 'upload') return { url: 'http://127.0.0.1:' + storage.address().port };
    assert.fail(action);
  });
  await work.poll(false);
  await until(() => work.view().task?.phase === 'Waiting to reconnect');
  await work.shutdown();
  assert.deepEqual(await fs.readFile(f.output), bytes);
  const restarted = f.open((action) => {
    if (action === 'reconcile') return { status: 'running', uploaded: stored };
    assert.equal(action, 'complete');
    return true;
  });
  await restarted.poll(false);
  await until(() => !restarted.busy());
  assert.equal(puts, 1);
  assert.deepEqual(f.actions, ['reconcile', 'upload', 'reconcile', 'complete']);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('an interrupted execution with a partial archive is reported once and never launched again', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, f.record.attempt + '.part'), 'partial');
  const work = f.open((action) =>
    action === 'reconcile' ? { status: 'running', uploaded: false } : true,
  );
  await work.poll(false);
  await until(() => !work.busy());
  assert.deepEqual(f.actions, ['reconcile', 'fail']);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('a new pairing cannot deliver the previous pairing’s archive', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'old');
  await f.open(() => assert.fail('unexpected request'), 'new').poll(false);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('an expired claim discards its cached result', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'old');
  const work = f.open(() => ({ status: 'failed', uploaded: false }));
  await work.poll(false);
  await until(() => !work.busy());
  assert.deepEqual(f.actions, ['reconcile']);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('a committed completion with a lost reply is acknowledged on the next poll', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'finished');
  let completed = false;
  const work = f.open((action) => {
    if (action === 'reconcile')
      return { status: completed ? 'completed' : 'running', uploaded: true };
    assert.equal(action, 'complete');
    completed = true;
    throw new Error('Connection interrupted');
  });
  await work.poll(false);
  await until(() => work.view().task?.phase === 'Waiting to reconnect');
  await work.poll(false);
  await until(() => !work.busy());
  assert.deepEqual(f.actions, ['reconcile', 'complete', 'reconcile']);
  assert.deepEqual(await fs.readdir(f.dir), []);
});
