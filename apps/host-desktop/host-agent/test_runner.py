import threading
import unittest
import uuid

from agent import Cancelled, cleanup, docker, ensure_image, execute


class DockerRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_image(threading.Event())

    def setUp(self):
        self.name = "grove-check-" + uuid.uuid4().hex
        self.label = "app.grove.test=" + self.name
        self.cancel = threading.Event()

    def tearDown(self):
        try:
            self.assertEqual(docker("ps", "-aq", "--filter", "label=" + self.label), "")
        finally:
            cleanup(self.name, self.label)

    def test_result(self):
        result = execute(self.name, self.label, self.cancel)
        self.assertEqual(result["bytes"], 8 * 1024**2)
        self.assertEqual(len(result["sha256"]), 64)

    def test_timeout(self):
        with self.assertRaisesRegex(RuntimeError, "time limit"):
            execute(self.name, self.label, self.cancel, "import time; time.sleep(60)", timeout=1)

    def test_memory_limit(self):
        with self.assertRaisesRegex(RuntimeError, "memory limit"):
            execute(self.name, self.label, self.cancel, "buf = bytearray(3 * 1024**3)")

    def test_stop(self):
        timer = threading.Timer(2, self.cancel.set)
        timer.start()
        try:
            with self.assertRaises(Cancelled):
                execute(self.name, self.label, self.cancel, "import time; time.sleep(60)")
        finally:
            timer.cancel()


if __name__ == "__main__":
    unittest.main()
