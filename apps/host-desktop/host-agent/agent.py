import hashlib
import json
import os
import platform
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

IMAGE = "python:3.12-alpine@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89"
WORKSPACE = 256 * 1024**2
def limits(cpus, memory_mib):
    memory = str(memory_mib * 1024**2)
    return ["--cpus", str(cpus), "--memory", memory, "--memory-swap", memory,
            "--pids-limit", "128", "--network", "none", "--read-only", "--user", "65534:65534",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--tmpfs", f"/work:rw,noexec,nosuid,nodev,size={WORKSPACE},mode=1777",
            "--workdir", "/work", "--log-driver", "local", "--log-opt", "max-size=5m",
            "--log-opt", "max-file=1", "--log-opt", "compress=false"]


LIMITS = limits(2, 2048)
FIXTURE = """
import hashlib, json, time
from pathlib import Path

root = Path('/sys/fs/cgroup')
quota, period = (root / 'cpu.max').read_text().split()
assert int(quota) == 2 * int(period), 'CPU quota unavailable'
assert (root / 'memory.max').read_text().strip() == str(2 * 1024**3), 'RAM limit unavailable'
assert (root / 'memory.swap.max').read_text().strip() == '0', 'Swap limit unavailable'
assert (root / 'pids.max').read_text().strip() == '128', 'Process limit unavailable'
digest = hashlib.sha256()
for i in range(8):
    digest.update(bytes([i]) * 1024**2)
    time.sleep(0.75)
result = Path('/work/result.json')
result.write_text(json.dumps({'bytes': 8 * 1024**2, 'sha256': digest.hexdigest()}))
print(result.read_text(), flush=True)
"""


class Cancelled(Exception):
    pass


def docker(*args, timeout=20):
    try:
        result = subprocess.run(["docker", *args], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=timeout,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except FileNotFoundError:
        raise RuntimeError("Install Docker and start its Linux engine.") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError("Docker did not respond in time.") from None
    if result.returncode:
        raise RuntimeError((result.stderr or "Docker command failed.").strip()[-500:])
    return result.stdout.strip()


def capabilities():
    caps = {"os": platform.system(), "arch": platform.machine(), "engine_arch": "", "cpus": 0,
            "memory_mib": 0, "disk_mib": shutil.disk_usage(tempfile.gettempdir()).free // 1024**2,
            "runtime": "unavailable", "agent_version": "0.1.0"}
    try:
        info = json.loads(docker("info", "--format", "{{json .}}", timeout=6))
        if info["OSType"] == "linux" and str(info["CgroupVersion"]) == "2":
            caps.update(engine_arch=info["Architecture"], cpus=info["NCPU"],
                        memory_mib=info["MemTotal"] // 1024**2, runtime="ready")
    except (RuntimeError, KeyError, ValueError):
        pass
    return caps


def emit(state, detail=""):
    print(json.dumps({"state": state, "detail": detail}), flush=True)


def ensure_image(cancel):
    try:
        docker("image", "inspect", "--format", "{{.Id}}", IMAGE)
        return
    except RuntimeError:
        pass
    emit("preparing", "Downloading the Python runtime…")
    with tempfile.TemporaryFile() as errors:
        with subprocess.Popen(["docker", "pull", IMAGE], stdout=subprocess.DEVNULL, stderr=errors,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as proc:
            deadline = time.monotonic() + 300
            try:
                while proc.poll() is None:
                    if cancel.wait(0.2):
                        raise Cancelled()
                    if time.monotonic() >= deadline:
                        raise RuntimeError("The Python runtime download timed out.")
                if proc.returncode:
                    raise RuntimeError("Could not download the Python runtime. Check Docker and your connection.")
            finally:
                if proc.poll() is None:
                    proc.kill()


def cleanup(name, label):
    found = docker("ps", "-aq", "--filter", f"name=^/{name}$", "--filter", f"label={label}")
    if found:
        docker("rm", "--force", found)


def execute(name, label, cancel, script=FIXTURE, timeout=900):
    if cancel.is_set():
        raise Cancelled()
    try:
        docker("create", "--name", name, "--label", label, *LIMITS, IMAGE, "python", "-IBc", script)
        if cancel.is_set():
            raise Cancelled()
        docker("start", name)
        deadline = time.monotonic() + timeout
        emit("running", "Computing an 8 MiB checksum")
        while True:
            if cancel.is_set() or time.monotonic() >= deadline:
                docker("stop", "--time", "2", name)
                if cancel.is_set():
                    raise Cancelled()
                raise RuntimeError("The job exceeded its time limit.")
            state = json.loads(docker("inspect", "--format", "{{json .State}}", name))
            if not state["Running"]:
                break
            cancel.wait(0.25)
        if state["OOMKilled"]:
            raise RuntimeError("The job exceeded its memory limit.")
        if state["ExitCode"]:
            raise RuntimeError("The test could not complete with the required Linux cgroup v2 limits.")
        result = json.loads(docker("logs", "--tail", "1", name))
        digest = hashlib.sha256()
        for i in range(8):
            digest.update(bytes([i]) * 1024**2)
        if result != {"bytes": 8 * 1024**2, "sha256": digest.hexdigest()}:
            raise RuntimeError("The result did not pass checksum verification.")
        return result
    finally:
        cleanup(name, label)


def main():
    folder = Path(sys.argv[1]).resolve()
    instance = hashlib.sha256(os.fsencode(folder)).hexdigest()[:20]
    name = f"grove-test-{instance}"
    label = f"app.grove.runner={instance}"
    cancel = threading.Event()
    requests = queue.Queue()
    lock = threading.Lock()
    active = False

    def read_requests():
        nonlocal active
        try:
            for line in sys.stdin:
                command = json.loads(line).get("command")
                with lock:
                    if command == "run" and not active:
                        active = True
                        cancel.clear()
                        requests.put("run")
                    elif command == "stop":
                        cancel.set()
                    elif command == "quit":
                        break
        finally:
            cancel.set()
            requests.put("quit")

    threading.Thread(target=read_requests, daemon=True).start()
    emit("ready")
    while requests.get() == "run":
        try:
            emit("preparing", "Checking Docker…")
            try:
                engine = docker("info", "--format", "{{.OSType}}")
            except RuntimeError as exc:
                raise RuntimeError("Start Docker with Linux containers, then retry.") from exc
            if engine != "linux":
                raise RuntimeError("Switch Docker to Linux containers.")
            cleanup(name, label)
            ensure_image(cancel)
            result = execute(name, label, cancel)
            folder.mkdir(parents=True, exist_ok=True)
            temp = folder / "result.tmp"
            temp.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            temp.replace(folder / "result.json")
            status = ("completed", "Checksum verified")
        except Cancelled:
            status = ("stopped", "Job stopped")
        except Exception as exc:
            status = ("failed", str(exc))
        with lock:
            active = False
        emit(*status)


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        print(json.dumps(capabilities()))
    elif len(sys.argv) == 3 and sys.argv[1] == "--job":
        from workload import main as run_job
        sys.exit(run_job(sys.argv[2]))
    else:
        main()
