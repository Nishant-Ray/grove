// Reviews: renters and hosts review each other after completed jobs; ratings drive sorting,
// recommendation cards and public profiles; duplicates and closed windows are refused.
import { chromium } from 'playwright';
import { WEB, addDevice, grantCredits, register, sql, stamp, suite } from './lib.mjs';

// 403: reviewing after the window closes; 409: reviewing twice. Both are tested on purpose.
const { check, session, shot, finish } = suite({ expectedStatuses: [409] });
const userId = (name) => sql(`select id from auth.users where email = '${name.toLowerCase()}-${stamp}@example.com'`);

async function host(browser, name, device) {
  const page = await session(browser, name);
  await register(page, name, /Host a device/);
  await addDevice(page, device);
  await page.getByRole('button', { name: /Continue to dashboard/ }).click();
  await page.getByText('Online: available devices can receive jobs').waitFor();
  return page;
}
async function search(page, sort = 'price') {
  // Via the dashboard, so a "Your job is booked." screen on #new-job is replaced by a fresh form.
  await page.goto(WEB + '/#account');
  await page.getByText('Job dashboard.').waitFor();
  await page.goto(WEB + '/#new-job');
  await page.getByLabel('Job name').fill('Review test job');
  await page.getByText('Standard · 1.3×').waitFor();
  await page.getByRole('button', { name: 'Find hosts' }).click();
  await page.getByText(/hosts? available/).waitFor();
  if (sort !== 'price') {
    await page.getByLabel('Sort by').selectOption(sort);
    await page.waitForTimeout(800);
  }
  return page.locator('.host-card-row');
}
async function bookAndRun(renter, hostPage, hostName) {
  const cards = await search(renter);
  await cards.filter({ hasText: hostName }).getByRole('button', { name: 'Book' }).click();
  await renter.getByText('Your job is booked.').waitFor();
  await hostPage.goto(WEB + '/#account');
  await hostPage.getByRole('button', { name: 'Hosting' }).click();
  await hostPage.getByRole('button', { name: 'Start job' }).click();
  await hostPage.getByRole('button', { name: 'Mark complete' }).click();
  await hostPage.getByText('No scheduled or running jobs').waitFor();
  return sql(`select id from compute_jobs where host_id = '${userId(hostName)}' order by requested_at desc limit 1`);
}
async function review(page, jobId, stars, comment) {
  await page.goto(WEB + '/#job/' + jobId);
  await page.getByRole('group', { name: /How was working with/ }).waitFor();
  await page.locator('.star-input label').nth(stars - 1).click();
  await page.getByLabel('Comment (optional)').fill(comment);
  await page.getByRole('button', { name: 'Post review' }).click();
  await page.getByText('Your review').waitFor();
}

const browser = await chromium.launch();
try {
  const hana = await host(browser, 'Hana', { name: 'Lab 4090', gpu: 'rtx-4090' });
  const hugo = await host(browser, 'Hugo', { name: 'Desk 4080', gpu: 'rtx-4080' });
  const rae = await session(browser, 'renter');
  await register(rae, 'Rae', /Rent compute/);
  grantCredits('Rae');
  await rae.getByText('Job dashboard.').waitFor();

  let cards = await search(rae);
  check('before any reviews both hosts are new', (await cards.allInnerTexts()).every((t) => t.includes('New host')));

  const hanaJob = await bookAndRun(rae, hana, 'Hana');
  const hugoJob = await bookAndRun(rae, hugo, 'Hugo');

  // Renter reviews Hana from the job page.
  await review(rae, hanaJob, 5, 'Started right away, results were perfect.');
  const mine = await rae.getByLabel('Reviews').innerText();
  check('renter sees their own review and the form is gone',
        mine.includes('Started right away') && (await rae.getByRole('button', { name: 'Post review' }).count()) === 0, mine);
  await shot(rae, '15-renter-review.png');

  // Hana is notified and reviews Rae back from the notification.
  await hana.evaluate(() => window.dispatchEvent(new Event('focus')));
  await hana.waitForFunction(() => /unread/.test(document.querySelector('.notify-bell')?.getAttribute('aria-label') ?? ''));
  await hana.getByRole('button', { name: /^Notifications/ }).click();
  const note = hana.getByRole('link', { name: /New review/ });
  check('host is notified with the rating and comment',
        (await note.innerText()).includes('Rae rated you 5 out of 5 for "Review test job": Started right away'));
  await note.click();
  await hana.getByText("Rae's review of you").waitFor();
  check('notification opens the job with the review', true);
  await review(hana, hanaJob, 4, 'Clear instructions.');

  await review(rae, hugoJob, 2, 'Took a while to start.');

  // Ratings in recommendations.
  cards = await search(rae);
  const byPrice = (await cards.allInnerTexts()).map((t) => (t.includes('Hana') ? 'Hana' : 'Hugo'));
  check('price sort is unchanged by ratings (cheaper 4080 first)', byPrice.join() === 'Hugo,Hana', byPrice.join());
  const hanaCard = await cards.filter({ hasText: 'Hana' }).innerText();
  check('card shows the rating and count', hanaCard.includes('5.0 (1)'), hanaCard);
  cards = await search(rae, 'rating');
  const byRating = (await cards.allInnerTexts()).map((t) => (t.includes('Hana') ? 'Hana' : 'Hugo'));
  check('rating sort puts the 5-star host first', byRating.join() === 'Hana,Hugo', byRating.join());
  await shot(rae, '16-rated-recommendations.png');

  // Public profiles.
  const href = await cards.filter({ hasText: 'Hana' }).getByRole('link', { name: 'Hana' }).getAttribute('href');
  check('host name links to their profile', href === '#user/' + userId('Hana'), href);
  await rae.goto(WEB + '/' + href);
  const flat = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ');
  const profile = await flat(rae.getByLabel('Reputation'));
  check('profile shows host rating, jobs and completion rate',
        profile.includes('5.0') && profile.includes('(1)') && profile.includes('1 · 100% of accepted jobs'), profile);
  check('profile lists the review with the reviewer',
        (await flat(rae.getByLabel('Reviews received'))).includes('Rae as renter'));
  await shot(rae, '17-host-profile.png');
  await hana.goto(WEB + '/#user/' + userId('Rae'));
  check('renters have a rating too', (await hana.getByLabel('Reputation').innerText()).includes('4.0'));

  // Refusals.
  const again = await rae.evaluate(async (id) => {
    const r = await fetch('/api/jobs/' + id + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Grove-Request': '1' }, body: JSON.stringify({ rating: 1 }) });
    return [r.status, (await r.json()).detail];
  }, hanaJob);
  check('reviewing twice is refused', again[0] === 409 && again[1] === 'You already reviewed this job.', JSON.stringify(again));
  sql(`update compute_jobs set finished_at = now() - interval '15 days' where id = '${hugoJob}'`);
  await hugo.goto(WEB + '/#job/' + hugoJob);
  await hugo.getByText("Rae's review of you").waitFor();
  check('after 14 days the form is gone', (await hugo.getByRole('button', { name: 'Post review' }).count()) === 0 &&
        (await hugo.getByText('Reviews close 14 days after a job completes.').count()) === 1);
  const late = await hugo.evaluate(async (id) => {
    const r = await fetch('/api/jobs/' + id + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Grove-Request': '1' }, body: JSON.stringify({ rating: 5 }) });
    return r.status;
  }, hugoJob);
  check('late reviews are refused by the API', late === 403, String(late));
} catch (error) {
  check('suite ran to the end', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
finish();
