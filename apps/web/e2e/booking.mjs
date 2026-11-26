// Booking: a host lists a device; a renter finds, books and follows it through completion.
import { chromium } from 'playwright';
import { WEB, register, suite } from './lib.mjs';

const { check, session, shot, finish } = suite();
const browser = await chromium.launch();
try {
  const host = await session(browser, 'host');
  const renter = await session(browser, 'renter');

  // Host: sign up, onboard, list a device ---------------------------------------------
  await register(host, 'Hana');
  await host.getByRole('button', { name: /Host a device/ }).click();
  await host.getByText('New device').waitFor();
  await host.getByLabel('Device name').fill('Lab 4090');
  await host.getByLabel('CPU model').fill('Ryzen 9 7950X');
  await host.getByLabel('System memory (GB)').fill('64');
  await host.locator('select[name=gpu_model]:not([disabled])').waitFor();
  await host.getByLabel('GPU model').selectOption('rtx-4090');
  check('choosing a GPU auto-fills its VRAM', (await host.getByLabel('GPU memory (GB, optional)').inputValue()) === '24');
  await host.getByLabel('Operating system').selectOption('Linux');
  await host.getByLabel('ZIP code').fill('14850');
  await host.getByLabel('This device runs on renewable energy').check();
  await host.getByLabel('Listing availability').selectOption('available');
  check('job acceptance defaults to automatic', (await host.getByLabel('Job acceptance').inputValue()) === 'automatic');
  await shot(host, '01-host-device-form.png');
  await host.getByRole('button', { name: 'Save listing' }).click();
  await host.getByRole('button', { name: /Continue to dashboard/ }).click();
  await host.getByText('Job dashboard.').waitFor();
  await host.getByText('Online: available devices can receive jobs').waitFor({ timeout: 10000 });
  check('host dashboard shows online presence', true);
  check('device listed with specs', await host.getByText('Ryzen 9 7950X · 64 GB RAM · NVIDIA RTX 4090 · Linux').isVisible());

  // Renter: sign up, find and book a host ----------------------------------------------
  await register(renter, 'Rae');
  await renter.getByRole('button', { name: /Rent compute/ }).click();
  await renter.getByText('Job dashboard.').waitFor();
  check('renter-only users see no Hosting switch', (await renter.getByRole('button', { name: 'Hosting' }).count()) === 0);
  await renter.getByRole('link', { name: 'Find a host' }).first().click();
  await renter.getByText('Find a host.').waitFor();
  await renter.getByLabel('Job name').fill('Train sentiment model');
  await renter.getByText('Standard · 1.3×').waitFor();
  check('Standard priority selected by default', await renter.getByLabel(/Standard/).isChecked());
  await renter.getByLabel('Estimated hours').fill('2');
  await renter.getByLabel('GPU memory needed').selectOption('16');
  await renter.getByLabel('Your ZIP code (optional)').fill('14850');
  await renter.getByLabel('Distance').selectOption('50');
  await renter.getByRole('button', { name: 'Find hosts' }).click();
  await renter.getByText(/hosts? available/).waitFor();
  const results = await renter.getByLabel('Recommended hosts').innerText();
  check('one host found', results.includes('1 host available'), results);
  check('card shows platform price', results.includes('$0.4511/hr'), results);
  check('card shows estimate and reserve', results.includes('≈ $0.90 total · $1.13 reserved'), results);
  check('card shows renewable badge and distance', results.includes('Renewable') && results.includes('Nearby'), results);
  check('card shows host name, not ZIP', results.includes('Hana') && !results.includes('14850'), results);
  await shot(renter, '02-renter-recommendations.png');

  await renter.getByLabel('Sort by').selectOption('green');
  await renter.getByText('1 host available').waitFor();
  check('re-sorting keeps results', true);

  await renter.getByRole('button', { name: 'Book', exact: true }).click();
  await renter.getByText('Your job is booked.').waitFor();
  check('auto-accept host books immediately', true);
  await shot(renter, '03-renter-booked.png');
  await renter.getByRole('link', { name: /Go to dashboard/ }).click();
  await renter.getByRole('heading', { name: 'Train sentiment model' }).waitFor();
  let row = await renter.locator('.job-row').first().innerText();
  check('renter sees scheduled job with rate and start deadline',
        /scheduled/i.test(row) && row.includes('$0.4511/hr') && row.includes('Start by'), row);
  check('renter can cancel a scheduled job', await renter.getByRole('button', { name: 'Cancel' }).isVisible());

  // A second renter can no longer see the booked host -------------------------------------
  const other = await session(browser, 'other');
  await register(other, 'Sam');
  await other.getByRole('button', { name: /Rent compute/ }).click();
  await other.getByText('Job dashboard.').waitFor();
  await other.goto(WEB + '/#new-job');
  await other.getByLabel('Job name').fill('Other job');
  await other.getByText('Standard · 1.3×').waitFor();
  await other.getByRole('button', { name: 'Find hosts' }).click();
  await other.getByText('No hosts match right now').waitFor();
  check('booked host is hidden from other renters', true);

  // Host runs the job -----------------------------------------------------------------
  await host.getByRole('button', { name: 'Hosting' }).click();
  await host.getByRole('heading', { name: 'Train sentiment model' }).waitFor();
  row = await host.locator('.job-row').first().innerText();
  check('host sees the job with their payout', row.includes('You earn $0.3609/hr'), row);
  await shot(host, '04-host-scheduled.png');
  await host.getByRole('button', { name: 'Start job' }).click();
  await host.getByRole('button', { name: 'Mark complete' }).waitFor();
  check('host started the job', /running/i.test(await host.locator('.job-row').first().innerText()));
  await host.waitForTimeout(3000); // bill a few seconds
  await host.getByRole('button', { name: 'Mark complete' }).click();
  await host.getByText('No scheduled or running jobs').waitFor();
  await host.getByRole('button', { name: 'History' }).click();
  row = await host.locator('.job-row').first().innerText();
  check('host history shows completion and earnings', /completed/i.test(row) && /Earned (less than )?\$/.test(row), row);
  await shot(host, '05-host-history.png');

  // Renter sees the result -----------------------------------------------------------------
  await renter.getByRole('button', { name: 'History' }).click();
  await renter.getByRole('heading', { name: 'Train sentiment model' }).waitFor();
  row = await renter.locator('.job-row').first().innerText();
  check('renter history shows completed and charge', /completed/i.test(row) && (row.includes('Charged less than $0.01') || row.includes('Charged $')), row);
  await shot(renter, '06-renter-history.png');

  // Mobile layout of the recommendations page --------------------------------------------
  const phone = await session(browser, 'phone', { width: 390, height: 844 });
  await register(phone, 'Mo');
  await phone.getByRole('button', { name: /Rent compute/ }).click();
  await phone.getByText('Job dashboard.').waitFor();
  await phone.goto(WEB + '/#new-job');
  await phone.getByLabel('Job name').fill('Phone job');
  await phone.getByText('Standard · 1.3×').waitFor();
  await phone.getByRole('button', { name: 'Find hosts' }).click();
  await phone.getByText(/hosts? available/).waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal scroll at phone width', overflow <= 0, `overflow ${overflow}px`);
  await shot(phone, '07-phone-recommendations.png');
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
