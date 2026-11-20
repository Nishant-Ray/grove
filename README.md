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

```powershell
cd apps/web
npm ci
npm run dev
```

The Vite dev server proxies `/api/*` to FastAPI at `127.0.0.1:8000`. Start both processes for account features.

### Run the API

From the repository root with Python 3.11 or newer:

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

The API exposes [a health endpoint](http://127.0.0.1:8000/health) and [interactive docs](http://127.0.0.1:8000/docs).

### Configure accounts and host listings

1. For local development or a PR preview, use a separate Supabase project with the email/password provider and signups enabled. Profiles use Supabase Auth user metadata.
2. Apply [the host devices migration](backend/supabase/migrations/20261119000100_host_devices.sql) in that project's SQL Editor. It creates the listing table and owner-only row policies.
3. Copy `backend/.env.example` to `backend/.env`. Set the project URL and publishable key, and set `GROVE_WEB_URL` to the exact browser origin. The API uses the signed-in user's token for device queries.
4. In Supabase Auth URL Configuration, allow `<GROVE_WEB_URL>/api/auth/confirm` as a redirect URL. With email confirmation enabled, use an email template containing Supabase's confirmation link. Configure SMTP for delivery to external users. Opening a confirmation on another device lets the user finish with password login.
5. For a hosted preview, route `/api/*` on the web origin to the same path on the deployed FastAPI server, preserving cookies and Set-Cookie headers. Set `GROVE_COOKIE_SECURE=true` on HTTPS. Use the production domain and migration at release time.

Pilot deployments from main continue to use the existing Edge Function. The [pilot setup guide](backend/supabase/SETUP.md) documents that deployment.
