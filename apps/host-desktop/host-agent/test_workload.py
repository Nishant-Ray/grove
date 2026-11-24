import io
import json
import tarfile
import tempfile
import threading
import unittest
import uuid
import zipfile
from pathlib import Path

from agent import docker, ensure_image
from workload import archive, run


class WorkloadTest(unittest.TestCase):
    def test_real_job(self):
        cancel = threading.Event()
        ensure_image(cancel)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "main.py"
            script.write_text("""
from pathlib import Path
quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().split()
assert int(quota) == int(period)
assert int(Path('/sys/fs/cgroup/memory.max').read_text()) == 512 * 1024**2
assert Path('/sys/fs/cgroup/memory.swap.max').read_text().strip() == '0'
assert len(list(Path('/sys/class/net').iterdir())) == 1
Path('/work/output/count.json').write_text(Path('/inputs/data.json').read_text())
print('finished')
""")
            data = root / "data.json"
            data.write_text('{"count":3}')
            attempt = uuid.uuid4()
            plan = {"attempt": str(attempt), "cpus": 1, "memory_mib": 512, "seconds": 10,
                    "files": [{"name": p.name, "url": p.as_uri(), "size": p.stat().st_size} for p in (script, data)]}
            result = root / "result.zip"
            run(plan, result, cancel, lambda: None)
            with zipfile.ZipFile(result) as files:
                self.assertEqual(json.loads(files.read("outputs/count.json")), {"count": 3})
                self.assertIn(b"finished", files.read("console.txt"))
            self.assertEqual(docker("ps", "-aq", "--filter", "label=app.grove.attempt=" + attempt.hex), "")

    def test_only_portable_regular_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name, kind in (("../result", tarfile.REGTYPE), ("file", tarfile.SYMTYPE),
                               ("file", tarfile.LNKTYPE), ("CON.txt", tarfile.REGTYPE)):
                with self.subTest(name=name, kind=kind):
                    buf = io.BytesIO()
                    with tarfile.open(fileobj=buf, mode="w") as tar:
                        member = tarfile.TarInfo(name)
                        member.type = kind
                        tar.addfile(member)
                    with self.assertRaises(ValueError):
                        archive(buf.getvalue(), b"", Path(tmp) / "output.zip")


if __name__ == "__main__":
    unittest.main()
