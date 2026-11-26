import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen
from uuid import UUID

from agent import Cancelled, IMAGE, cleanup, docker, limits

MIB = 1024**2
CHECK_BUDGET = """
from pathlib import Path
import sys
root = Path('/sys/fs/cgroup')
quota, period = map(int, (root / 'cpu.max').read_text().split())
assert quota == int(sys.argv[1]) * period
assert int((root / 'memory.max').read_text()) == int(sys.argv[2]) * 1024**2
assert (root / 'memory.swap.max').read_text().strip() == '0'
assert (root / 'pids.max').read_text().strip() == '128'
Path('/work/output').mkdir()
"""


def portable(name):
    return (re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}", name)
            and not name.endswith(".")
            and not re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", name))


def download(files, folder, cancel):
    total = 0
    names = set()
    if not 1 <= len(files) <= 9 or files[0]["name"] != "main.py":
        raise ValueError("Invalid input manifest.")
    for item in files:
        name, size = item["name"], item["size"]
        total += size
        if not portable(name) or name.lower() in names or size < 0 or total > 16 * MIB:
            raise ValueError("Invalid input manifest.")
        names.add(name.lower())
        remaining = size
        with urlopen(Request(item["url"]), timeout=20) as response, (folder / name).open("xb") as target:
            while True:
                if cancel.is_set():
                    raise Cancelled()
                block = response.read(min(65536, remaining + 1))
                if not block:
                    break
                remaining -= len(block)
                if remaining < 0:
                    raise ValueError("Input exceeds its declared size.")
                target.write(block)
        if remaining:
            raise ValueError("Incomplete input file.")
        (folder / name).chmod(0o444)


def capture(args, limit, seconds, cancel, truncate=False):
    data = bytearray()
    overflow = threading.Event()
    with subprocess.Popen(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as proc:
        def drain():
            while block := proc.stdout.read(65536):
                available = limit - len(data)
                data.extend(block[:available])
                if len(block) > available and not truncate:
                    overflow.set()
                    return
        reader = threading.Thread(target=drain)
        reader.start()
        deadline = time.monotonic() + seconds
        try:
            while proc.poll() is None:
                if cancel.wait(0.05):
                    raise Cancelled()
                if overflow.is_set():
                    raise ValueError("Result archive is too large.")
                if time.monotonic() >= deadline:
                    raise TimeoutError("The job exceeded its time limit.")
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            reader.join()
        if overflow.is_set():
            raise ValueError("Result archive is too large.")
        if proc.returncode:
            if not truncate:
                raise RuntimeError("Could not collect the output directory.")
            detail = bytes(data[-400:]).decode("utf-8", "replace")
            detail = " ".join(detail.splitlines())[-220:]
            raise RuntimeError(f"Job {args[0]} exited with code {proc.returncode}. {detail}")
    return data


def archive(tar, log, output):
    seen = set()
    total = len(log)
    with tarfile.open(fileobj=io.BytesIO(tar), mode="r:") as src, zipfile.ZipFile(output, "w") as dest:
        dest.writestr("console.txt", log)
        for count, member in enumerate(src):
            if count >= 512:
                raise ValueError("Too many output entries.")
            path = PurePosixPath(member.name)
            if path.is_absolute() or not all(portable(part) for part in path.parts):
                raise ValueError("Use portable names for output files.")
            if member.isdir():
                continue
            if not member.isfile() or member.issparse() or member.name.lower() in seen:
                raise ValueError("Outputs must be regular files with unique names.")
            seen.add(member.name.lower())
            total += member.size
            if total > 50 * MIB:
                raise ValueError("Results exceed 50 MiB.")
            with src.extractfile(member) as file:
                dest.writestr("outputs/" + str(path), file.read())
    if output.stat().st_size > 50 * MIB:
        raise ValueError("Results exceed 50 MiB.")


def run(plan, output, cancel, authorize):
    cpus, memory, seconds = (plan[k] for k in ("cpus", "memory_mib", "seconds"))
    if not (1 <= cpus <= 64 and 256 <= memory <= 65536 and 1 <= seconds <= 900):
        raise ValueError("Invalid resource budget.")
    attempt = UUID(plan["attempt"]).hex
    name = "grove-job-" + attempt
    label = "app.grove.attempt=" + attempt
    with tempfile.TemporaryDirectory() as folder:
        inputs = Path(folder) / "inputs"
        inputs.mkdir()
        download(plan["files"], inputs, cancel)
        if cancel.is_set():
            raise Cancelled()
        inputs.chmod(0o755)
        try:
            docker("run", "-d", "--rm", "--init", "--name", name, "--label", label, *limits(cpus, memory),
                   "--volume", f"{inputs}:/inputs:ro", IMAGE, "sleep", str(seconds + 90))
            docker("exec", name, "python", "-IBc", CHECK_BUDGET, str(cpus), str(memory))
            authorize()
            log = capture(["exec", name, "python", "-IB", "/inputs/main.py"], 5 * MIB, seconds, cancel, True)
            tar = capture(["exec", name, "tar", "-cf", "-", "-C", "/work/output", "."], 52 * MIB, 40, cancel)
            partial = output.with_suffix(".part")
            archive(tar, log, partial)
            with partial.open("rb+") as result:
                os.fsync(result.fileno())
            partial.replace(output)
        finally:
            cleanup(name, label)


def main(output):
    cancel = threading.Event()
    approved = threading.Event()
    plan = json.loads(sys.stdin.readline())

    def control():
        try:
            for line in sys.stdin:
                if line.strip() == "run":
                    approved.set()
                else:
                    break
        finally:
            cancel.set()
            approved.set()

    def authorize():
        print(json.dumps({"phase": "ready"}), flush=True)
        if not approved.wait(40) or cancel.is_set():
            raise Cancelled()

    threading.Thread(target=control, daemon=True).start()
    try:
        run(plan, Path(output), cancel, authorize)
        print(json.dumps({"phase": "finished"}), flush=True)
    except Exception as exc:
        print(json.dumps({"phase": "error", "message": str(exc) if isinstance(exc, (ValueError, RuntimeError, TimeoutError))
                          else "The job was interrupted or file transfer failed."}), flush=True)
        return 1
    return 0
