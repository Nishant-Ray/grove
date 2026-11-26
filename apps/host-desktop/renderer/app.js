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
  action.disabled = !!hostState?.task || ['starting', 'stopping'].includes(state);
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
  renderOffers(next);
  action.disabled = !!next.task || ['starting', 'stopping'].includes(state);
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

function jobButton(label, fn) {
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = fn;
  return button;
}
function renderOffers({ device, online, connected, offers, automatic, task, jobMessage }) {
  byId('requests').hidden = !device || (!online && !task && !jobMessage);
  const list = byId('offers');
  list.replaceChildren();
  byId('job-message').textContent = jobMessage;
  if (task) {
    const status = document.createElement('p');
    status.textContent = task.name + ' · ' + task.phase;
    list.append(status);
    if (['Accepting', 'Downloading inputs', 'Running'].includes(task.phase))
      list.append(jobButton('Stop job', () => window.hosting.stopJob()));
    return;
  }
  if (!connected || !online) return;
  if (!offers.length)
    list.textContent = automatic
      ? 'Automatically accepting requests within your limits.'
      : 'Waiting for a request.';
  for (const offer of offers) {
    const row = document.createElement('article');
    const title = document.createElement('strong');
    title.textContent = offer.name;
    const budget = document.createElement('p');
    budget.textContent =
      'Python CPU · ' +
      offer.cpus +
      ' cores · ' +
      offer.memory_mib +
      ' MiB · ' +
      offer.seconds +
      ' seconds · ' +
      Math.ceil(offer.bytes / 1024) +
      ' KiB input';
    const accept = jobButton('Accept job', () => window.hosting.accept(offer.id));
    accept.disabled = !['ready', 'completed', 'failed', 'stopped'].includes(state);
    row.append(
      title,
      budget,
      accept,
      jobButton('Decline', () => window.hosting.decline(offer.id)),
    );
    list.append(row);
  }
}
window.runner.listen((snapshot) => {
  render(snapshot);
  if (hostState) renderOffers(hostState);
});
window.runner.state().then(render);
