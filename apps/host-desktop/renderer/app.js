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
