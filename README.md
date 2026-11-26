# Grove

Grove connects people who need affordable computing power with people who have it to spare. We help students bring their ideas to life while making better use of existing hardware.

Run a project. Share your spare power. Grow something good.

## Project layout

- `apps/web/` contains the React/Vite app.
- `apps/host-desktop/` contains the Electron host app and bundled Python agent. See the [local runner guide](apps/host-desktop/README.md).
- `backend/app/` contains the FastAPI app.
- `backend/supabase/` contains the Supabase project and the pilot signup function.

### Run the web app

From the repository root:

```bash
cd apps/web
npm ci
npm run dev
```

The Vite dev server proxies `/api/*` to FastAPI at `127.0.0.1:8000`. Start both processes for account features.

### Run the API

From the repository root with Python 3.11 or newer:

```bash
cd backend
python -m venv .venv
pip install -e .
uvicorn app.main:app --reload
```

The API exposes [a health endpoint](http://127.0.0.1:8000/health) and [interactive docs](http://127.0.0.1:8000/docs).

### Pricing

Prices are set by the platform: `price/hr = base[gpu] × priority × reliability`, hosts receive 80%, and a host is only offered for a job when its payout covers `power_kW × $/kWh × 1.5`. Rates, priority levels and settings live in the `gpu_rates`, `priority_levels`, `grove_settings` and `electricity_rates` tables and can be edited in Supabase without redeploying. `GET /api/quote?host_device_id=…&priority=standard&hours=2` returns the renter price, host payout and floor check.

```bash
cd backend
python -m unittest discover tests        # API and pricing tests
supabase start && supabase test db       # database tests (needs Docker)
python scripts/price_matrix.py --states  # which GPUs clear the power floor, by state
```

### Host matching

Renters open **Find a host** (`#new-job`), describe the job (priority, hours, GPU memory, optional ZIP, distance and renewable-only filters) and book a host from a ranked list. `GET /api/hosts/recommendations` returns hosts that are available, online (their dashboard is open, so it sends a heartbeat every minute), not busy, have enough VRAM and clear the power floor, sorted by price, renewable energy or rating. `POST /api/jobs` re-quotes on the server and books. Hosts then accept, decline, start, complete or fail jobs from the dashboard. Unaccepted requests and jobs not started in time are cancelled automatically by `pg_cron`.

Booking and job actions run in database functions that only the API's service role can call, so the API needs `SUPABASE_SECRET_KEY` (server only).

### Tests

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

```bash
# Backend unit tests
cd backend && python -m unittest discover tests

# Database tests (pgTAP) — needs Docker
cd backend && ../apps/web/node_modules/.bin/supabase start && ../apps/web/node_modules/.bin/supabase test db

# Browser tests — needs local Supabase, the API on :8000 and the web app on :5173
#   API: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY come from `supabase status`
cd apps/web && npx playwright install chromium   # once
npm run test:e2e                                  # all suites: booking, notifications, messaging, read-markers
npm run test:e2e -- messaging                     # one suite
```

The browser runner resets the local database before each suite (set `E2E_SKIP_RESET=1` to keep it). Screenshots are saved to `apps/web/e2e/.shots/`.

### Payments (Stripe, test mode)

Renters buy prepaid credits through Stripe Checkout. Booking reserves the estimate × 1.25 from the available balance, a finished job charges per second (capped at the reserve, nothing for host-side failures or cancellations), and the host earns their share in a ledger. Hosts withdraw earnings to a Stripe Connect Express account. All money rules run in the database (`*_credits.sql`); the ledger always balances.

Local setup, with test keys in `backend/.env` (`STRIPE_SECRET_KEY`):

```bash
stripe listen --api-key "$STRIPE_SECRET_KEY" --print-secret        # put the whsec_… value in STRIPE_WEBHOOK_SECRET
stripe listen --api-key "$STRIPE_SECRET_KEY" --forward-to http://127.0.0.1:8000/api/stripe/webhook \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,account.updated
cd apps/web && npm run test:e2e -- payments                       # real Checkout with test cards (opt-in)
```

Host payouts need Stripe Connect enabled on the platform account (Dashboard → Connect). Production needs a webhook endpoint at `https://<api-domain>/api/stripe/webhook` for the same three events.
