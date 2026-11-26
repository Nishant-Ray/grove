const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { promisify } = require('node:util');
const path = require('node:path');
const { createInterface } = require('node:readline');

function jobs(directory, identity, executable, request, publish, canAccept) {
  let offers = [],
    task,
    worker,
    stopping = false,
    message = '';

  function phase(value) {
    if (task) task.phase = value;
    publish();
  }
  async function execute(plan, output, job, attempt) {
    const child = spawn(executable, ['--job', output], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    worker = child;
    child.stdin.on('error', () => {});
    let finished = false,
      error;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', async (line) => {
      try {
        const event = JSON.parse(line);
        if (event.phase === 'ready') {
          await request('begin', job, attempt);
          if (child.stdin.writable && !stopping && !closed) {
            phase('Running');
            child.stdin.write('run\n');
          } else child.stdin.end();
        } else if (event.phase === 'finished') finished = true;
        else if (event.phase === 'error') error = new Error(event.message);
      } catch (err) {
        error = err;
        child.stdin.end();
      }
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.write(JSON.stringify({ ...plan, attempt }) + '\n');
    const timer = setTimeout(() => child.stdin.end(), (plan.seconds + 180) * 1000);
    try {
      const code = await exit;
      if (error) throw error;
      if (code !== 0 || !finished || stopping) throw new Error('The host stopped the job.');
    } finally {
      clearTimeout(timer);
      worker = undefined;
      lines.close();
    }
  }

  const journal = path.join(directory, 'attempt.json');
  let saved,
    flight,
    closed = false,
    restored = false,
    needsCleanup = false,
    automatic = false,
    upload;

  function output() {
    return path.join(directory, saved.attempt + '.zip');
  }

  async function store(next) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(journal + '.tmp', JSON.stringify(next), { mode: 0o600, flush: true });
    await rename(journal + '.tmp', journal);
    saved = next;
  }

  async function forget(notice) {
    if (saved) {
      if (needsCleanup) await cleanContainer(saved.attempt);
      await rm(output(), { force: true });
      await rm(output().replace(/\.zip$/, '.part'), { force: true });
      await rm(journal, { force: true });
    }
    saved = task = undefined;
    message = notice;
  }

  async function restore() {
    if (restored) return;
    let data;
    try {
      data = JSON.parse(await readFile(journal, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (data) {
      if (
        ![data.id, data.attempt].every(
          (id) => typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id),
        )
      )
        throw new Error('Could not read the saved job attempt.');
      saved = data;
      task = { name: data.name, phase: 'Reconnecting' };
      needsCleanup = !!data.executing;
      if (data.device !== identity()) await forget('Previous pairing removed.');
      else if (data.executing) await cleanContainer(data.attempt).catch(() => {});
    }
    restored = true;
    publish();
  }

  async function cleanContainer(attempt) {
    await promisify(execFile)(executable, ['--cleanup-job', attempt], {
      windowsHide: true,
      timeout: 25000,
    });
    needsCleanup = false;
  }

  function launch(work) {
    flight = work()
      .catch((err) => {
        message = err.message || 'Could not reach Grove.';
        if (saved) phase('Waiting to reconnect');
        else task = undefined;
      })
      .finally(() => {
        flight = undefined;
        publish();
      });
  }

  async function reconcile() {
    const { id, attempt, name } = saved;
    let remote;
    try {
      remote = await request('reconcile', id, attempt);
    } catch (err) {
      if (err.unavailable) return forget('This claim is no longer available.');
      throw err;
    }
    if (['failed', 'cancelled', 'completed'].includes(remote.status))
      return forget(name + ' ' + remote.status + '.');
    let result;
    try {
      result = await stat(output());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (saved.outcome === 'cancel' || (!result && !remote.uploaded)) {
      const outcome = saved.outcome || 'fail';
      const detail = saved.detail || 'Execution was interrupted before a result was saved.';
      await request(outcome, id, attempt, detail);
      return forget(detail);
    }
    if (closed) return;
    phase('Uploading result');
    if (!remote.uploaded) {
      const { url } = await request('upload', id, attempt);
      if (closed) return;
      upload = new AbortController();
      try {
        const response = await fetch(url, {
          method: 'PUT',
          body: await readFile(output()),
          headers: { 'Content-Type': 'application/octet-stream' },
          redirect: 'error',
          signal: AbortSignal.any([upload.signal, AbortSignal.timeout(60000)]),
        });
        if (!response.ok) throw new Error('Result upload interrupted. Grove will retry.');
      } finally {
        upload = undefined;
      }
    }
    await request('complete', id, attempt);
    await forget(name + ' completed.');
  }

  async function run(offer, auto) {
    const id = offer.id,
      attempt = randomUUID();
    await store({ id, attempt, name: offer.name, device: identity() });
    await request(auto ? 'auto_accept' : 'accept', id, attempt);
    try {
      const plan = await request('inputs', id, attempt);
      if (stopping || closed) throw new Error('The host stopped the job.');
      if (
        plan.cpus !== offer.cpus ||
        plan.memory_mib !== offer.memory_mib ||
        plan.seconds !== offer.seconds
      )
        throw new Error('The job budget changed after approval.');
      await store({ ...saved, executing: true });
      if (stopping || closed) throw new Error('The host stopped the job.');
      phase('Downloading inputs');
      needsCleanup = true;
      await execute(plan, output(), id, attempt);
      needsCleanup = false;
    } catch (err) {
      await store({
        ...saved,
        outcome: stopping ? 'cancel' : 'fail',
        detail: (stopping ? 'Stopped by host.' : err.message || 'Execution interrupted.').slice(
          0,
          300,
        ),
      });
    }
    if (!closed) await reconcile();
  }

  function accept(id, auto = false) {
    const offer = offers.find((row) => row.id === id);
    if (!offer || !restored || closed || flight || task || !canAccept(offer)) return;
    stopping = false;
    task = { name: offer.name, phase: 'Accepting' };
    offers = [];
    message = '';
    publish();
    launch(() => run(offer, auto));
  }

  return {
    view: () => ({ offers, automatic, task: task && { ...task }, jobMessage: message }),
    busy: () => !!task,
    restore,
    async poll(online) {
      await restore();
      offers = [];
      if (closed || flight) return;
      if (saved) {
        launch(reconcile);
        return;
      }
      if (!online) return;
      const queue = await request('queue');
      if (closed || task) return;
      offers = queue.offers;
      automatic = queue.automatic;
      if (automatic && offers.length) accept(offers[0].id, true);
    },
    accept: (id) => accept(id),
    async decline(id) {
      if (!offers.some((row) => row.id === id) || task) return;
      try {
        await request('decline', id);
        offers = offers.filter((row) => row.id !== id);
      } catch (err) {
        message = err.message;
      }
      publish();
    },
    stop() {
      if (!flight || !task || !['Accepting', 'Downloading inputs', 'Running'].includes(task.phase))
        return;
      stopping = true;
      worker?.stdin.end();
    },
    async revoked() {
      stopping = true;
      worker?.stdin.end();
      upload?.abort();
      await flight;
      await forget('Device access revoked.');
      offers = [];
      automatic = false;
    },
    async shutdown() {
      closed = true;
      worker?.stdin.end();
      upload?.abort();
      await flight;
    },
  };
}
module.exports = { jobs };
