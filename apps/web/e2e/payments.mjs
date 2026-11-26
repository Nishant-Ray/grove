// Payments against Stripe test mode: top up through the real Stripe Checkout page (declined, then
// accepted card), book and run a job, then check charges, earnings and the ledger. Needs the API to
// have STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, with `stripe listen` forwarding to
// /api/stripe/webhook. Opt-in: npm run test:e2e -- payments
import { chromium } from 'playwright';
import { SHOTS, WEB, addDevice, register, sql, stamp, suite } from './lib.mjs';

// 402: booking without credits; 503: payout setup before Connect is enabled. Both are tested on purpose.
const { check, session, shot, finish } = suite({ expectedStatuses: [402, 503] });
const userId = (name) => sql(`select id from auth.users where email = '${name.toLowerCase()}-${stamp}@example.com'`);
const wallet = (id) => sql(`select balance_micros || '/' || reserved_micros || '/' || earnings_micros from wallets where user_id = '${id}'`);

async function payOnStripe(page, card) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  const form = page.frameLocator('iframe[src*="elements-inner"]').first();
  const number = form.locator('#payment-numberInput');
  if (!(await number.isVisible().catch(() => false))) {
    await form.getByText('Card', { exact: true }).first().click();
  }
  await number.fill(card);
  await form.locator('#payment-expiryInput').fill('12 / 34');
  await form.locator('#payment-cvcInput').fill('123');
  await form.locator('#payment-nameInput').fill('Rae Renter');
  const zip = form.locator('#payment-postalCodeInput');
  if (await zip.isVisible().catch(() => false)) await zip.fill('14850');
  const linkOptIn = form.locator('#payment-linkOptInInput');
  if (await linkOptIn.isChecked().catch(() => false)) await linkOptIn.uncheck({ force: true });
  await form.getByRole('button', { name: 'Pay', exact: true }).click();
  return form;
}

const browser = await chromium.launch();
try {
  const host = await session(browser, 'host');
  const renter = await session(browser, 'renter');

  await register(host, 'Hana', /Host a device/);
  await addDevice(host, { name: 'Lab 4090', gpu: 'rtx-4090' });
  await host.getByRole('button', { name: /Continue to dashboard/ }).click();
  await host.getByText('Online: available devices can receive jobs').waitFor();

  // 1. No credits: booking is refused with a way to add credits.
  await register(renter, 'Rae', /Rent compute/);
  await renter.getByText('Job dashboard.').waitFor();
  await renter.goto(WEB + '/#new-job');
  await renter.getByLabel('Job name').fill('Paid training run');
  await renter.getByLabel('Estimated hours').fill('2');
  await renter.getByText('Standard · 1.3×').waitFor();
  await renter.getByRole('button', { name: 'Find hosts' }).click();
  await renter.getByText('$0.00 in credits').waitFor();
  check('booking page shows available credits', true);
  await renter.getByRole('button', { name: 'Book', exact: true }).click();
  const refusal = await renter.getByRole('alert').innerText();
  check('booking without credits is refused with a top-up link',
        refusal.includes("You don't have enough credits") && refusal.includes('Add credits'), refusal);

  // 2. Wallet starts empty.
  await renter.getByRole('link', { name: 'Add credits' }).click();
  await renter.getByLabel('Compute credits').waitFor();
  check('wallet starts at $0.00', (await renter.getByTestId('available').innerText()).startsWith('$0.00'));
  check('renters do not see a host earnings card', (await renter.getByLabel('Host earnings').count()) === 0);

  // 3. Real Stripe Checkout: declined card first, then a working one.
  await renter.getByRole('button', { name: 'Add $25' }).click();
  let form = await payOnStripe(renter, '4000 0000 0000 0002');
  await form.getByText(/declined/i).first().waitFor({ timeout: 30000 });
  check('a declined card is refused by Stripe', true);
  check('no credits after a declined card', wallet(userId('Rae')) === '' || wallet(userId('Rae')).startsWith('0/'));
  form = await payOnStripe(renter, '4242 4242 4242 4242');
  await renter.waitForURL((url) => url.href.startsWith(WEB) && url.hash === '#wallet', { timeout: 60000 });
  await renter.getByText('Payment received: $25.00 in credits added.').waitFor();
  check('returning from Stripe credits the wallet', (await renter.getByTestId('available').innerText()).startsWith('$25.00'));
  check('return URL is cleaned up', !renter.url().includes('session_id'), renter.url());
  await shot(renter, '12-wallet-topped-up.png');

  // 4. The webhook for the same payment arrives too, and must not double-credit.
  const rae = userId('Rae');
  let webhookSeen = false;
  for (let i = 0; i < 20 && !webhookSeen; i++) {
    webhookSeen = sql(`select count(*) from stripe_events where type = 'checkout.session.completed'`) !== '0';
    if (!webhookSeen) await renter.waitForTimeout(1000);
  }
  check('Stripe webhook delivered and verified', webhookSeen);
  check('credited exactly once (return page + webhook)',
        sql(`select count(*) from ledger_entries where user_id = '${rae}' and kind = 'topup'`) === '1' && wallet(rae) === '25000000/0/0',
        wallet(rae));

  // 5. Cancelled checkout.
  await renter.goto(WEB + '/?checkout=cancelled#wallet');
  await renter.getByText('Checkout cancelled. You were not charged.').waitFor();
  check('cancelled checkout is explained', true);

  // 6. Book: the reserve is held, not charged.
  await renter.goto(WEB + '/#new-job');
  await renter.getByLabel('Job name').fill('Paid training run');
  await renter.getByLabel('Estimated hours').fill('2');
  await renter.getByText('Standard · 1.3×').waitFor();
  await renter.getByRole('button', { name: 'Find hosts' }).click();
  await renter.getByText('$25.00 in credits').waitFor();
  await renter.getByRole('button', { name: 'Book', exact: true }).click();
  await renter.getByText('Your job is booked.').waitFor();
  check('reserve of estimate x 1.25 is held', wallet(rae) === '25000000/1127750/0', wallet(rae));
  await renter.goto(WEB + '/#wallet');
  await renter.getByText('Reserved for a job').waitFor();
  check('wallet shows available after the reserve', (await renter.getByTestId('available').innerText()).startsWith('$23.87'));

  // 7. Host runs the job for a few seconds.
  await host.getByRole('button', { name: 'Hosting' }).click();
  await host.getByRole('button', { name: 'Start job' }).click();
  await host.getByRole('button', { name: 'Mark complete' }).waitFor();
  await host.waitForTimeout(4000);
  await host.getByRole('button', { name: 'Mark complete' }).click();
  await host.getByText('No scheduled or running jobs').waitFor();

  const charged = Number(sql(`select charged_micros from compute_jobs where owner_id = '${rae}'`));
  check('per-second charge recorded', charged > 0 && charged < 10000, `${charged} micro-dollars`);
  check('renter pays only the usage and the reserve is released', wallet(rae) === `${25000000 - charged}/0/0`, wallet(rae));
  const hana = userId('Hana');
  const earned = Number(sql(`select earnings_micros from wallets where user_id = '${hana}'`));
  const fee = Number(sql(`select coalesce(sum(amount_micros), 0) from ledger_entries where kind = 'grove_fee' and job_id = (select id from compute_jobs where owner_id = '${rae}')`));
  check('host earns ~80% and Grove keeps the rest', earned + fee === charged && earned >= Math.floor(charged * 0.79), `charged ${charged}, earned ${earned}, fee ${fee}`);

  await renter.reload();
  await renter.getByText('Compute used').waitFor();
  check('renter activity shows the usage and release', (await renter.getByLabel('Activity').innerText()).includes('Reserve released'));
  await shot(renter, '13-wallet-after-job.png');

  // 8. Host earnings and payout setup.
  await host.goto(WEB + '/#wallet');
  await host.getByLabel('Host earnings').waitFor();
  check('host sees earnings', (await host.getByTestId('earnings').innerText()).includes('ready to withdraw'));
  await host.getByRole('button', { name: 'Set up payouts' }).click();
  const outcome = await Promise.race([
    host.waitForURL(/connect\.stripe\.com/, { timeout: 30000 }).then(() => 'stripe'),
    host.getByRole('alert').waitFor({ timeout: 30000 }).then(() => 'alert'),
  ]);
  if (outcome === 'stripe') check('payout setup opens Stripe Connect onboarding', true);
  else {
    const text = await host.getByRole('alert').innerText();
    check('payout setup explains when Connect is not enabled', text.includes('needs Connect enabled'), text);
  }
  await shot(host, '14-host-wallet.png');

  // 9. Books balance across everyone.
  const balanced = sql(`with l as (select kind, sum(amount_micros) s from ledger_entries group by kind),
      v as (select coalesce((select s from l where kind = k), 0) as s, k from unnest(array['topup','charge','reserve','release','host_earning','grove_fee','withdrawal','withdrawal_reversal']) k),
      g as (select k, s from v)
    select (select s from g where k='topup') - (select s from g where k='charge') = (select coalesce(sum(balance_micros),0) from wallets)
       and (select s from g where k='reserve') - (select s from g where k='release') = (select coalesce(sum(reserved_micros),0) from wallets)
       and (select s from g where k='charge') = (select s from g where k='host_earning') + (select s from g where k='grove_fee')
       and (select s from g where k='host_earning') - (select s from g where k='withdrawal') + (select s from g where k='withdrawal_reversal') = (select coalesce(sum(earnings_micros),0) from wallets)`);
  check('ledger and wallets balance', balanced === 't', balanced);
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
