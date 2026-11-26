# Grove Host

Run the bundled checksum fixture in a temporary Docker container and save its verified JSON result. Closing the window requests cancellation and cleanup.

## Develop on Windows

Use Node 22.12+ and Python 3.11+. Start Docker Desktop with Linux containers and cgroup v2. Docker must be accessible to the signed-in user and available on PATH. The first run downloads a pinned multi-architecture Python image.

From `apps/host-desktop`:

```powershell
npm ci
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r host-agent/requirements-build.txt
.venv/Scripts/python host-agent/build.py
npm start
```

Use `npm run package` after building the agent to create an unpacked app under `dist/package`. The packaged app includes Python. Build the agent and Electron app on the same OS and architecture. On macOS or Linux, use `.venv/bin/python` for the build commands.

## Pair a device

Apply `backend/supabase/migrations/20261121000200_host_pairing.sql` to the same Supabase project as the Grove API and deploy the matching web and API revisions. For local development, set `GROVE_WEB_URL=http://127.0.0.1:5173` in the shell that launches Electron and start the web app and API. Desktop defaults to the deployed Grove web origin.

Choose **Pair in browser**, compare the eight-character code with the desktop, and approve a listing you own. The link expires in ten minutes. The desktop stores its credential using the OS keyring. On Linux this requires an available system secret store. Run the checksum test, set CPU and memory limits, and select **Go online**. The local checksum fixture uses its own limits shown on the test card.

**Profile & devices** shows the runtime and sharing status alongside the listing. Heartbeats run about every 15 seconds. After 60 seconds without a heartbeat, Grove shows the desktop as offline. Restarting the app restores its pairing and limits in paused mode. Choose **Unlink desktop** in the web profile to revoke access.

## Verify the limits

Run `.venv/Scripts/python host-agent/test_runner.py` with Docker running. The tests start real containers, including a memory exhaustion test inside the 2 GiB container limit. Allow at least 3 GiB of Docker VM memory.

The runner uses a non-root user, read-only root, 256 MiB temporary workspace, disabled networking, two CPUs, 2 GiB RAM with no swap, 128 PIDs, bounded Docker logs and a 15-minute execution deadline. The fixture checks its effective cgroup quotas and returns one checksum record. After verification the agent atomically saves the latest result under the desktop app's user data directory.

## Run a pilot job

Apply `backend/supabase/migrations/20261123000100_pilot_jobs.sql` and set `SUPABASE_SECRET_KEY` in the FastAPI environment. Use the same project as `SUPABASE_URL`. Keep this key on the backend. FastAPI uses it to issue scoped Storage links after authorizing the renter or device.

1. Pair the desktop, verify Docker, and go online. Share the device ID from **Profile & devices** with the renter.
2. In the dashboard choose **New job**. Enter that ID, select a Python script and up to eight input files (16 MiB total), and request CPU, memory and time. The runtime includes the Python 3.12 standard library. Files are available under `/inputs`, with the script named `main.py`.
3. Review the offer on the host desktop and choose **Accept job** or **Decline**. Each device runs one accepted job at a time. Pausing prevents new claims. **Stop job** ends the current execution.
4. Write regular output files under `/work/output`. A completed job in **History** includes a ZIP with `outputs/` and up to 5 MiB of console output. The overall archive limit is 50 MiB. The renter can close the site once the request appears under **Requests**.

The server verifies the input objects before publishing the request and the result object before marking it complete. Pending execution claims expire after the requested runtime plus five minutes. The recovery-capable desktop reserves 24 hours after the execution budget for result delivery. The container still enforces the requested runtime.

## Recovery and automatic acceptance

Apply `backend/supabase/migrations/20261126000100_job_recovery.sql` before updating the host desktop and FastAPI. On restart the desktop reconnects in paused mode and checks its saved attempt. A finished ZIP is retried on the next successful heartbeat, including while paused. If Storage already has the ZIP, Grove finalizes the job directly. If execution was interrupted before a ZIP was saved, the job is marked failed. The renter can submit a fresh request. Expired or revoked claims cannot publish results.

In the web profile, edit a device’s **Job acceptance** setting to opt into automatic acceptance. Go online from the verified desktop to enable it for the session. Manual acceptance is the default. Waking the computer pauses new claims until you run the checksum test and go online again.

Run `npm run installer` after building the bundled agent to create a native installer for the build machine under `dist/package`. Pilot machines need Docker with Linux containers. The app includes its own Python runtime.
