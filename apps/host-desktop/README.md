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

## Verify the limits

Run `.venv/Scripts/python host-agent/test_runner.py` with Docker running. The tests start real containers, including a memory exhaustion test inside the 2 GiB container limit. Allow at least 3 GiB of Docker VM memory.

The runner uses a non-root user, read-only root, 256 MiB temporary workspace, disabled networking, two CPUs, 2 GiB RAM with no swap, 128 PIDs, bounded Docker logs and a 15-minute execution deadline. The fixture checks its effective cgroup quotas and returns one checksum record. After verification the agent atomically saves the latest result under the desktop app's user data directory.
