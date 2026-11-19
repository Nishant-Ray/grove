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

For pilot submissions, use `apps/web/.env.example` as a template for `apps/web/.env.local`. See the [Supabase setup guide](backend/supabase/SETUP.md).

### Run the API

From the repository root with Python 3.11 or newer:

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

The API exposes [a health endpoint](http://127.0.0.1:8000/health) and [interactive docs](http://127.0.0.1:8000/docs).
