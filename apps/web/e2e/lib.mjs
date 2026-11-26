// Shared helpers for the browser suites. Each suite drives the real web app (Vite) against the
// real API and local Supabase, using separate browser sessions per person.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export const WEB = process.env.E2E_WEB_URL || 'http://127.0.0.1:5173';
export const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
export const SHOTS = process.env.E2E_SHOTS || new URL('./.shots/', import.meta.url).pathname;
export const stamp = Date.now().toString(36);
mkdirSync(SHOTS, { recursive: true });

const container = process.env.E2E_DB_CONTAINER || 'supabase_db_grove';
// Run SQL against the local Supabase database (for setting up time-based states).
export const sql = (query) =>
  execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', query]).toString().trim();

// expectedStatuses: HTTP error codes this suite triggers on purpose (401/403/404 always are).
export function suite({ expectedStatuses = [] } = {}) {
  const expected = new Set([401, 403, 404, ...expectedStatuses]);
  let ok = 0;
  let fail = 0;
  const errors = [];
  const check = (name, cond, detail = '') => {
    cond ? ok++ : fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `  -> ${detail}`));
  };
  async function session(browser, name, viewport = { width: 1280, height: 900 }) {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('dialog', (d) => d.accept());
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const status = Number(/status of (\d{3})/.exec(m.text())?.[1]);
      if (!expected.has(status)) errors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    return page;
  }
  const shot = (page, file) => page.screenshot({ path: SHOTS + file, fullPage: true });
  function finish() {
    if (errors.length) check('no console errors', false, errors.join('\n  '));
    console.log(`\n${ok} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
  return { check, session, shot, finish };
}

// Sign up; then pick a starting point (e.g. /Rent compute/) or stop at onboarding.
export async function register(page, name, role) {
  await page.goto(WEB + '/#register');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(`${name.toLowerCase()}-${stamp}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  if (role) await page.getByRole('button', { name: role }).click();
  else await page.getByText('How will you use').waitFor();
}

// Fill and save the device form (host onboarding or "Add device").
export async function addDevice(page, { name, gpu, acceptance = 'automatic', zip = '14850', green = false }) {
  await page.getByLabel('Device name').fill(name);
  await page.getByLabel('CPU model').fill('Ryzen 9 7950X');
  await page.getByLabel('System memory (GB)').fill('64');
  await page.locator('select[name=gpu_model]:not([disabled])').waitFor();
  await page.getByLabel('GPU model').selectOption(gpu);
  await page.getByLabel('Operating system').selectOption('Linux');
  await page.getByLabel('ZIP code').fill(zip);
  if (green) await page.getByLabel('This device runs on renewable energy').check();
  await page.getByLabel('Listing availability').selectOption('available');
  await page.getByLabel('Job acceptance').selectOption(acceptance);
  await page.getByRole('button', { name: 'Save listing' }).click();
}

// Give a test user credits through the same database function a paid Stripe Checkout uses.
export function grantCredits(name, usd = 50) {
  const email = `${name.toLowerCase()}-${stamp}@example.com`;
  return sql(`select public.credit_topup((select id from auth.users where email = '${email}'),
                                         'cs_e2e_${email}_${Date.now()}', ${Math.round(usd * 1_000_000)})`);
}
