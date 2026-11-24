const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

function jobs(executable, request, publish, canAccept) {
  let offers = [],
    task,
    worker,
    completion,
    stopping = false,
    message = '';

  async function poll(online) {
    offers = online && !task ? await request('offers') : [];
  }
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
          await request('running', job, attempt);
          if (child.stdin.writable && !stopping) {
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

  async function run(offer, attempt) {
    const id = offer.id;
    let folder,
      accepted = false;
    try {
      await request('accept', id, attempt);
      accepted = true;
      const plan = await request('inputs', id, attempt);
      if (stopping) throw new Error('The host stopped the job.');
      if (
        plan.cpus !== offer.cpus ||
        plan.memory_mib !== offer.memory_mib ||
        plan.seconds !== offer.seconds
      )
        throw new Error('The job budget changed after approval.');
      folder = await mkdtemp(path.join(tmpdir(), 'grove-output-'));
      const output = path.join(folder, 'result.zip');
      phase('Downloading inputs');
      await execute(plan, output, id, attempt);
      phase('Uploading result');
      const { url } = await request('upload', id, attempt);
      const response = await fetch(url, {
        method: 'PUT',
        body: await readFile(output),
        headers: { 'Content-Type': 'application/octet-stream' },
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('Result upload failed.');
      await request('complete', id, attempt);
      message = offer.name + ' completed.';
    } catch (err) {
      message = err.message || 'The job could not finish.';
      if (accepted) await request(stopping ? 'cancel' : 'fail', id, attempt, message.slice(0, 300)).catch(() => {});
    } finally {
      try {
        if (folder) await rm(folder, { recursive: true, force: true });
      } finally {
        task = undefined;
        completion = undefined;
        publish();
      }
    }
  }

  return {
    view: () => ({ offers, task: task && { ...task }, jobMessage: message }),
    poll,
    busy: () => !!task,
    accept(id) {
      const offer = offers.find((row) => row.id === id);
      if (!offer || task || !canAccept(offer)) return;
      stopping = false;
      task = { name: offer.name, phase: 'Accepting' };
      offers = [];
      message = '';
      publish();
      completion = run(offer, randomUUID());
    },
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
      stopping = true;
      worker?.stdin.end();
      return completion;
    },
  };
}

module.exports = { jobs };
