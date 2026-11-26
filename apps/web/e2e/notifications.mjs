// Notifications: booking, status updates, reading and the bell panel, host and renter sessions.
import { chromium } from 'playwright';
import { SHOTS, WEB, register, suite } from './lib.mjs';

const { check, session, shot, finish } = suite();
const bell = (page) => page.getByRole('button', { name: /^Notifications/ });
async function openPanel(page) {
  await bell(page).click();
  const panel = page.getByRole('region', { name: 'Notifications' });
  await panel.waitFor();
  await page.waitForTimeout(500); // let the refresh on open land
  return panel;
}

const browser = await chromium.launch();
try {
  const host = await session(browser, 'host');
  const renter = await session(browser, 'renter');

  await register(host, 'Hana', /Host a device/);
  await host.getByLabel('Device name').fill('Lab 4090');
  await host.getByLabel('CPU model').fill('Ryzen 9');
  await host.getByLabel('System memory (GB)').fill('64');
  await host.locator('select[name=gpu_model]:not([disabled])').waitFor();
  await host.getByLabel('GPU model').selectOption('rtx-4090');
  await host.getByLabel('Operating system').selectOption('Linux');
  await host.getByLabel('ZIP code').fill('14850');
  await host.getByLabel('Listing availability').selectOption('available');
  await host.getByRole('button', { name: 'Save listing' }).click();
  await host.getByRole('button', { name: /Continue to dashboard/ }).click();
  await host.getByText('Online: available devices can receive jobs').waitFor();
  check('new host starts with no unread notifications', (await bell(host).getAttribute('aria-label')) === 'Notifications');
  let panel = await openPanel(host);
  check('empty state', (await panel.innerText()).includes("You're all caught up."));
  await host.keyboard.press('Escape');
  check('Escape closes the panel', (await host.getByRole('region', { name: 'Notifications' }).count()) === 0);

  await register(renter, 'Rae', /Rent compute/);
  await renter.getByText('Job dashboard.').waitFor();
  await renter.goto(WEB + '/#new-job');
  await renter.getByLabel('Job name').fill('Train sentiment model');
  await renter.getByText('Standard · 1.3×').waitFor();
  await renter.getByRole('button', { name: 'Find hosts' }).click();
  await renter.getByRole('button', { name: 'Book', exact: true }).click();
  await renter.getByText('Your job is booked.').waitFor();

  // The host's bell refreshes on window focus and every 30 s; trigger the focus refresh.
  await host.evaluate(() => window.dispatchEvent(new Event('focus')));
  await host.waitForFunction(() => document.querySelector('.notify-bell')?.getAttribute('aria-label') === 'Notifications, 1 unread');
  check('host bell shows 1 unread after the booking', true);
  panel = await openPanel(host);
  const hostText = await panel.innerText();
  check('host is told who booked what, where',
        hostText.includes('New job booked') && hostText.includes('Rae booked "Train sentiment model" on Lab 4090'), hostText);
  await host.screenshot({ path: SHOTS + '08-host-notification.png' });
  await panel.getByRole('link', { name: /New job booked/ }).click();
  await host.waitForFunction(() => document.querySelector('.notify-bell')?.getAttribute('aria-label') === 'Notifications');
  check('opening a notification marks it read', true);

  // Host starts the job; the renter hears about scheduling and the start.
  check('notification opens the job page', /#job\/[0-9a-f-]{36}$/.test(host.url()), host.url());
  await host.getByRole('button', { name: 'Start job' }).click();
  await host.getByRole('button', { name: 'Mark complete' }).waitFor();
  await renter.evaluate(() => window.dispatchEvent(new Event('focus')));
  await renter.waitForFunction(() => document.querySelector('.notify-bell')?.getAttribute('aria-label') === 'Notifications, 2 unread');
  check('renter bell shows 2 unread (scheduled, started)', true);
  panel = await openPanel(renter);
  const renterText = await panel.innerText();
  check('renter sees "Job started" above "Job scheduled"',
        renterText.indexOf('Job started') > -1 && renterText.indexOf('Job started') < renterText.indexOf('Job scheduled'), renterText);
  await panel.getByRole('button', { name: 'Mark all read' }).click();
  await renter.waitForFunction(() => document.querySelector('.notify-bell')?.getAttribute('aria-label') === 'Notifications');
  check('mark all read clears the badge', true);
  check('read items stay listed', (await panel.innerText()).includes('Job started'));

  // Completion
  await host.getByRole('button', { name: 'Mark complete' }).click();
  await host.locator('.job-status.completed').waitFor();
  await renter.keyboard.press('Escape');
  await renter.evaluate(() => window.dispatchEvent(new Event('focus')));
  await renter.waitForFunction(() => document.querySelector('.notify-bell')?.getAttribute('aria-label') === 'Notifications, 1 unread');
  panel = await openPanel(renter);
  check('renter is told the job completed', (await panel.innerText()).includes('"Train sentiment model" finished.'));
  await renter.mouse.click(5, 5);
  check('clicking outside closes the panel', (await renter.getByRole('region', { name: 'Notifications' }).count()) === 0);

  // Phone layout
  const phone = await session(browser, 'phone', { width: 390, height: 844 });
  await register(phone, 'Mo', /Rent compute/);
  await phone.getByText('Job dashboard.').waitFor();
  await openPanel(phone);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('panel fits a phone screen', overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: SHOTS + '09-phone-notifications.png' });
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
