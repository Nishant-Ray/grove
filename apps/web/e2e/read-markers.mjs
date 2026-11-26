// Read markers: an open thread must not re-send "mark as read" on every poll, only when a
// new message from the other person arrives.
import { chromium } from 'playwright';
import { API, WEB, stamp, suite } from './lib.mjs';

const { check, session, finish } = suite();
const H = { 'X-Grove-Request': '1', 'Content-Type': 'application/json' };

async function user(name, mode) {
  const r = await fetch(API + '/api/auth/register', {
    method: 'POST', headers: H,
    body: JSON.stringify({ email: `${name.toLowerCase()}-${stamp}@example.com`, password: 'correct-horse-1', display_name: name }),
  });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (path, method = 'GET', body) =>
    fetch(API + path, { method, headers: { ...H, cookie }, body: body && JSON.stringify(body) }).then((x) => x.json());
  await call('/api/profile/preference', 'PUT', { mode });
  return call;
}

const host = await user('Hana', 'host');
const renter = await user('Rae', 'rent');
const device = await host('/api/devices', 'POST', {
  name: 'Lab', hardware: 'x', availability: 'available', gpu_model: 'rtx-4090', zip: '14850',
  specs: { cpu: 'x', ram_gb: 8, os: 'Linux' },
});
await host('/api/devices/heartbeat', 'POST');
const job = await renter('/api/jobs', 'POST', { name: 'Read test', host_device_id: device.id, priority: 'standard', hours: '1' });
await renter(`/api/jobs/${job.id}/messages`, 'POST', { body: 'Hi' });
await host(`/api/jobs/${job.id}/messages`, 'POST', { body: 'Hello from the host' });

const browser = await chromium.launch();
try {
  const page = await session(browser, 'renter');
  const counts = { polls: 0, reads: 0 };
  page.on('request', (r) => {
    if (r.url().includes(`/api/jobs/${job.id}/messages/read`)) counts.reads++;
    else if (r.method() === 'GET' && r.url().includes(`/api/jobs/${job.id}/messages`)) counts.polls++;
  });
  await page.goto(WEB + '/#login');
  await page.getByLabel('Email').fill(`rae-${stamp}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByText('Job dashboard.').waitFor();
  await page.goto(WEB + '/#job/' + job.id);
  await page.locator('.bubble').nth(1).waitFor();
  const opened = { ...counts };
  await page.waitForTimeout(20000);
  check('thread keeps polling while open', counts.polls >= opened.polls + 3, JSON.stringify(counts));
  check('no repeated mark-read while idle', counts.reads === opened.reads, `${counts.reads - opened.reads} extra calls`);
  await host(`/api/jobs/${job.id}/messages`, 'POST', { body: 'One more thing' });
  await page.locator('.bubble').nth(2).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  check('exactly one mark-read for a new message', counts.reads === opened.reads + 1, `${counts.reads - opened.reads} calls`);
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
