# Grove

Grove connects people who need affordable computing power with people who have it to spare. We help students bring their ideas to life while making better use of existing hardware.

Run a project. Share your spare power. Grow something good.

## Project layout

- `apps/web/` contains the React/Vite app.
- `apps/host-desktop/` is reserved for the desktop app. It is currently empty and Git does not track empty directories.
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
