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
