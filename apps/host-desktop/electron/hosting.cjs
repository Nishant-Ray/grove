const { safeStorage, shell } = require('electron');
const { randomBytes, createHash } = require('node:crypto');
const { readFile, writeFile, rename, unlink } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);
const defaultLimits = { cpus: 1, memory_mib: 1024 };

function webOrigin() {
  const url = new URL(process.env.GROVE_WEB_URL || 'https://grove-kappa-six.vercel.app');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('Use an HTTPS Grove URL or a local development server.');
  return url.origin;
}

function hosting(directory, executable, publish) {
  const origin = webOrigin();
  const key = createHash('sha256').update(origin).digest('hex').slice(0, 16);
  const file = path.join(directory, 'host-' + key + '.bin');
  let record,
    caps,
    timer,
    message = '',
    connected = false,
    online = false,
    verified = false;
  let closed = false,
    queue = Promise.resolve(),
    probedAt = 0;
  function fingerprint() {
    return createHash('sha256').update(record.secret).digest('hex');
  }
  function view() {
    return {
      device: record?.device,
      pending: !!record && !record.device,
      code: record && !record.device ? fingerprint().slice(0, 8).toUpperCase() : '',
      online,
      connected,
      verified,
      caps,
      limits: record?.limits || defaultLimits,
      message,
    };
  }
  function storeAvailable() {
    return (
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    );
  }
  async function save(next) {
    if (!storeAvailable())
      throw new Error('Unlock the operating system keyring to pair this device.');
    await writeFile(file + '.tmp', safeStorage.encryptString(JSON.stringify(next)), {
      mode: 0o600,
    });
    await rename(file + '.tmp', file);
    record = next;
  }
  async function clear(reason) {
    await unlink(file).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    record = undefined;
    online = connected = false;
    message = reason;
  }
  async function sync() {
    if (!record) return;
    if (!caps || Date.now() - probedAt >= 15000) {
      try {
        const { stdout } = await run(executable, ['--probe'], {
          windowsHide: true,
          timeout: 10000,
        });
        caps = JSON.parse(stdout);
      } catch {
        caps = {
          os: process.platform,
          arch: process.arch,
          engine_arch: '',
          cpus: 0,
          memory_mib: 0,
          disk_mib: 0,
          runtime: 'unavailable',
          agent_version: 'unknown',
        };
      }
      probedAt = Date.now();
    }
    if (caps.runtime !== 'ready') verified = false;
    if (!verified || record.limits.cpus > caps.cpus || record.limits.memory_mib > caps.memory_mib)
      online = false;
    let response;
    try {
      response = await fetch(origin + '/api/hosts/heartbeat', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'application/json',
          'X-Grove-Request': '1',
          Authorization: 'Bearer ' + record.secret,
        },
        body: JSON.stringify({
          online,
          limits: record.limits,
          capabilities: { ...caps, checksum_verified: verified },
        }),
      });
      const data = await response.json();
      if (response.status === 401 && response.headers.get('X-Grove-Device') === 'unlinked') {
        connected = false;
        if (record.device) await clear('This desktop was unlinked. Pair again to reconnect.');
        else if (Date.now() >= record.expires * 1000)
          await clear('The pairing code expired. Pair again to get a new code.');
        else message = 'Compare the code and approve this desktop in your browser.';
        return;
      }
      if (!response.ok || typeof data.device !== 'string') throw new Error();
      if (record.device !== data.device) await save({ ...record, device: data.device });
      connected = true;
      message = '';
    } catch {
      connected = false;
      message = 'Connection interrupted. Retrying automatically.';
    }
  }
  function enqueue(work) {
    const step = queue.then(async () => {
      if (closed) return;
      clearTimeout(timer);
      try {
        await work();
      } finally {
        publish(view());
        if (!closed && record)
          timer = setTimeout(() => enqueue(sync).catch(fail), record.device ? 15000 : 3500);
      }
    });
    queue = step.catch(() => {});
    return step;
  }
  function fail(error) {
    message = error.message;
    publish(view());
  }
  function loadRecord() {
    return readFile(file)
      .then((bytes) => {
        if (!storeAvailable()) throw new Error('Unlock the operating system keyring to reconnect.');
        record = JSON.parse(safeStorage.decryptString(bytes));
      })
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  return {
    view,
    start: () =>
      enqueue(async () => {
        await loadRecord();
        await sync();
      }).catch(fail),
    pair: () =>
      enqueue(async () => {
        if (!record) await loadRecord();
        if (record?.device) return;
        if (!record || record.expires <= Date.now() / 1000) {
          const expires = Math.floor(Date.now() / 1000) + 600;
          const secret = expires + '.' + randomBytes(32).toString('hex');
          await save({ secret, expires, limits: defaultLimits });
        }
        publish(view());
        await shell.openExternal(origin + '/#pair/' + fingerprint() + '/' + record.expires);
        await sync();
      }).catch(fail),
    limits: (limits) =>
      enqueue(async () => {
        if (
          !record?.device ||
          !Number.isInteger(limits?.cpus) ||
          !Number.isInteger(limits?.memory_mib) ||
          limits.cpus < 1 ||
          limits.cpus > caps?.cpus ||
          limits.memory_mib < 256 ||
          limits.memory_mib > caps?.memory_mib
        )
          throw new Error('Choose sharing limits within the detected capacity.');
        await save({ ...record, limits: { cpus: limits.cpus, memory_mib: limits.memory_mib } });
        await sync();
      }).catch(fail),
    toggle: (enabled) =>
      enqueue(async () => {
        if (!record?.device || (enabled && (!connected || !verified))) return;
        online = enabled === true;
        await sync();
      }).catch(fail),
    verify: (ok) => {
      verified = ok;
      if (!ok) online = false;
      publish(view());
      if (record) enqueue(sync).catch(fail);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { hosting };
