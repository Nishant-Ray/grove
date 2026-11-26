from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
out = root / "dist"
subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir",
                "--name", "grove-agent", "--distpath", str(out / "agent"),
                "--workpath", str(out / "pyinstaller"), "--specpath", str(out),
                str(root / "host-agent" / "agent.py")], check=True)
