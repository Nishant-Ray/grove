// Messaging: locked before acceptance, live replies, notifications, closing, outsiders.
import { chromium } from 'playwright';
import { SHOTS, WEB, addDevice, register, sql, stamp, suite } from './lib.mjs';

const { check, session, shot, finish } = suite();
const bubbles = async (page) => (await page.locator('.bubble').allInnerTexts()).map((t) => t.replace(/\n\n/g, '\n'));

const browser = await chromium.launch();
try {
  const host = await session(browser, 'host');
  const renter = await session(browser, 'renter');

  await register(host, 'Hana', /Host a device/);
  await addDevice(host, { name: 'Lab 4070', gpu: 'rtx-4070', acceptance: 'manual' });
  await host.getByRole('button', { name: /Continue to dashboard/ }).click();
  await host.getByText('Online: available devices can receive jobs').waitFor();

  await register(renter, 'Rae', /Rent compute/);
  await renter.getByText('Job dashboard.').waitFor();
  await renter.goto(WEB + '/#new-job');
  await renter.getByLabel('Job name').fill('Notebook run');
  await renter.getByText('Standard · 1.3×').waitFor();
  await renter.getByRole('button', { name: 'Find hosts' }).click();
  await renter.getByRole('button', { name: 'Book', exact: true }).click();
  await renter.getByText('Request sent.').waitFor();
  await renter.getByRole('link', { name: /Go to dashboard/ }).click();
  await renter.getByRole('button', { name: 'Requests' }).click();
  check('no Messages link before acceptance', (await renter.getByRole('link', { name: 'Messages' }).count()) === 0);
  await renter.getByRole('link', { name: 'Notebook run' }).click();
  await renter.getByText('Messaging opens once the host accepts').waitFor();
  const jobUrl = renter.url();
  check('job page shows the host and locks messaging before acceptance',
        (await renter.locator('.job-parties').innerText()).includes('hosted by Hana'));

  // Host accepts from the dashboard.
  await host.getByRole('button', { name: 'Hosting' }).click();
  await host.getByRole('button', { name: 'Requests' }).click();
  await host.getByRole('button', { name: 'Accept' }).click();
  await host.getByText('No pending requests').waitFor();

  // Renter's thread opens; send with Enter.
  await renter.reload();
  await renter.getByText('No messages yet. Say hello to Hana').waitFor();
  check('thread opens after acceptance', true);
  const box = renter.getByLabel('Message Hana');
  await box.fill('Hi Hana! Dataset link is in the repo README.');
  await box.press('Enter');
  await renter.locator('.bubble.mine').waitFor();
  check('Enter sends; message shows as mine', (await bubbles(renter))[0].startsWith('You\nHi Hana!'), await bubbles(renter));
  check('composer clears after sending', (await box.inputValue()) === '');

  // Host is notified and lands in the thread from the notification.
  await host.evaluate(() => window.dispatchEvent(new Event('focus')));
  await host.waitForFunction(() => /unread/.test(document.querySelector('.notify-bell')?.getAttribute('aria-label') ?? ''));
  await host.getByRole('button', { name: /^Notifications/ }).click();
  const note = host.getByRole('link', { name: /New message about "Notebook run"/ });
  check('host notification previews the message', (await note.innerText()).includes('Rae: Hi Hana! Dataset link is in the repo README.'));
  await note.click();
  await host.locator('.bubble').first().waitFor();
  check('notification opens the job thread', host.url() === jobUrl, host.url());
  check("host sees the renter's message", (await bubbles(host))[0].startsWith('Rae\nHi Hana!'));
  check('host header names the renter', (await host.locator('.job-parties').innerText()).includes("Rae's job on your Lab 4070"));

  // Host replies with a multi-line message using the Send button.
  const hostBox = host.getByLabel('Message Rae');
  await hostBox.fill('Thanks!');
  await hostBox.press('Shift+Enter');
  await hostBox.pressSequentially('Starting in 5 minutes.');
  check('Shift+Enter adds a new line instead of sending', (await hostBox.inputValue()) === 'Thanks!\nStarting in 5 minutes.');
  await host.getByRole('button', { name: 'Send message' }).click();
  await host.locator('.bubble.mine').waitFor();

  // Renter receives it by polling (every 5 s) without reloading.
  await renter.waitForFunction(() => document.querySelectorAll('.bubble').length === 2, null, { timeout: 15000 });
  const last = (await bubbles(renter))[1];
  check('renter receives the reply live, line breaks kept', last.startsWith('Hana\nThanks!\nStarting in 5 minutes.'), last);
  await renter.waitForTimeout(1500);
  check("viewing the thread marks the renter's message notification read",
        sql(`select count(*) from notifications n join auth.users u on u.id = n.user_id
             where n.kind = 'new_message' and n.read_at is null and u.raw_user_meta_data->>'display_name' = 'Rae'`) === '0');
  await renter.screenshot({ path: SHOTS + '10-thread-renter.png', fullPage: true });

  // Dashboard rows link to the thread once accepted.
  await host.goto(WEB + '/#account');
  await host.getByRole('button', { name: 'Hosting' }).click();
  await host.getByRole('link', { name: 'Messages' }).waitFor({ timeout: 10000 });
  check('accepted jobs show a Messages link', true);

  // An outsider cannot open the job.
  const outsider = await session(browser, 'outsider');
  await register(outsider, 'Sam', /Rent compute/);
  await outsider.getByText('Job dashboard.').waitFor();
  await outsider.goto(jobUrl);
  await outsider.getByText('Job could not be found.').waitFor();
  check('outsiders get "Job could not be found."', true);

  // Threads close 14 days after the job ends; history stays readable.
  const jobId = jobUrl.split('#job/')[1];
  sql(`update compute_jobs set status = 'completed', outcome_reason = 'completed', started_at = now() - interval '16 days',
       finished_at = now() - interval '15 days' where id = '${jobId}'`);
  await renter.reload();
  await renter.getByText('This conversation is closed.').waitFor();
  await renter.waitForFunction(() => document.querySelectorAll('.bubble').length === 2);
  check('closed thread hides the composer but keeps history',
        (await renter.getByLabel('Message Hana').count()) === 0 && (await bubbles(renter)).length === 2);

  // Phone layout
  const phone = await session(browser, 'phone', { width: 390, height: 844 });
  await phone.goto(WEB + '/#login');
  await phone.getByLabel('Email').fill(`hana-${stamp}@example.com`);
  await phone.getByLabel('Password').fill('correct-horse-1');
  await phone.getByRole('button', { name: 'Log in' }).click();
  await phone.getByText('Job dashboard.').waitFor();
  await phone.goto(jobUrl);
  await phone.locator('.bubble').first().waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('thread fits a phone screen', overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: SHOTS + '11-thread-phone.png', fullPage: true });
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
