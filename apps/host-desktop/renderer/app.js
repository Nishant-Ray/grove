const action = document.querySelector('#action');
const save = document.querySelector('#save');
const detail = document.querySelector('#detail');
let state = 'starting';
const labels = {
  starting: ['Connecting', 'Connecting…'],
  ready: ['Idle', 'Run test job'],
  preparing: ['Preparing', 'Stop job'],
  running: ['Running', 'Stop job'],
  stopping: ['Stopping', 'Stopping…'],
  completed: ['Completed', 'Run again'],
  failed: ['Failed', 'Retry test'],
  stopped: ['Stopped', 'Run again'],
  offline: ['Agent offline', 'Reconnect'],
};

function render(snapshot) {
  state = snapshot.state;
  document.body.dataset.state = state;
  document.querySelector('#status').textContent = labels[state][0];
  action.textContent = labels[state][1];
  action.disabled = ['starting', 'stopping'].includes(state);
  save.hidden = state !== 'completed';
  detail.textContent = snapshot.detail;
}

action.onclick = () =>
  ['preparing', 'running'].includes(state) ? window.runner.stop() : window.runner.run();
save.onclick = async () => {
  try {
    await window.runner.save();
  } catch {
    detail.textContent = 'Could not save the file. Choose another location.';
  }
};
window.runner.listen(render);
window.runner.state().then(render);

const byId = (id) => document.getElementById(id);
let hostState;
let savedLimits;
let working = false;

function renderHost(next) {
  hostState = next;
  const { device, pending, code, caps, online, connected, verified, limits, message } = next;
  const ready = caps?.runtime === 'ready';
  let presence = pending ? 'Pairing' : 'Unpaired';
  let guidance = 'Choose a device listing in your Grove account.';
  if (device) {
    presence = online ? 'Online' : 'Paused';
    if (!connected) presence = 'Reconnecting';
    if (!connected) guidance = 'Waiting for a connection to Grove.';
    else if (online) guidance = 'Grove can see this desktop is available.';
    else if (!ready) guidance = 'Start Docker with Linux containers and cgroup v2.';
    else if (!verified) guidance = 'Run the checksum test below to enable hosting.';
    else guidance = 'Choose your sharing limits, then go online.';
  }
  byId('presence').textContent = presence;
  byId('device').textContent = device || 'Pair this desktop';
  byId('guidance').textContent = guidance;
  byId('code').textContent = code ? code.slice(0, 4) + ' ' + code.slice(4) : '';
  byId('code').hidden = !pending;
  byId('pair').hidden = !!device;
  byId('pair').disabled = working;
  byId('pair').textContent = pending ? 'Open browser again' : 'Pair in browser';
  byId('toggle').hidden = !device;
  byId('toggle').textContent = online ? 'Pause hosting' : 'Go online';
  byId('toggle').disabled =
    working ||
    (!online &&
      (!connected ||
        !verified ||
        !ready ||
        limits.cpus > caps.cpus ||
        limits.memory_mib > caps.memory_mib));
  byId('limits').hidden = !device || !ready;
  const values = JSON.stringify(limits);
  if (savedLimits !== values || !device) {
    byId('cpus').value = limits.cpus;
    byId('ram').value = limits.memory_mib;
    savedLimits = values;
  }
  byId('cpus').max = caps?.cpus || 1;
  byId('ram').max = caps?.memory_mib || 256;
  byId('apply').disabled = working;
  byId('capacity').textContent =
    device && ready
      ? 'Docker capacity · ' +
        caps.cpus +
        ' cores · ' +
        (caps.memory_mib / 1024).toFixed(1) +
        ' GiB · ' +
        caps.engine_arch
      : '';
  byId('notice').textContent = message;
}

async function act(work) {
  if (working) return;
  working = true;
  renderHost(hostState);
  try {
    await work();
  } finally {
    working = false;
    renderHost(await window.hosting.state());
  }
}
byId('pair').onclick = () => act(() => window.hosting.pair());
byId('toggle').onclick = () => act(() => window.hosting.online(!hostState.online));
byId('limits').onsubmit = (event) => {
  event.preventDefault();
  act(() =>
    window.hosting.limits({
      cpus: byId('cpus').valueAsNumber,
      memory_mib: byId('ram').valueAsNumber,
    }),
  );
};
window.hosting.listen(renderHost);
window.hosting.state().then(renderHost);
