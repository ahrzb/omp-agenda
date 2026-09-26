#!/usr/bin/env python3
"""Record the README demo: a real omp session, driven by scripted keystrokes, under asciinema.

Needs Linux (or WSL) with `omp`, `asciinema` 3 and python3 on PATH, and omp logged in to Anthropic.

    python3 demo/record.py            # writes demo/demo.cast
    agg --idle-time-limit 3 demo/demo.cast demo/demo.gif

The model's replies are live, so every recording differs; re-run until the take reads well.
"""

import fcntl
import os
import pty
import select
import shlex
import shutil
import struct
import sys
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "demo", "demo.cast")
WORK = "/tmp/omp-agenda-demo"
COLS, ROWS = 110, 32

ALT_G = "\x1bg"
ALT_SHIFT_G = "\x1bG"
ENTER = "\r"
TAB = "\t"
CTRL_C = "\x03"

OMP = shlex.join([
    "omp",
    "--session-dir", f"{WORK}/sessions",
    "-e", f"{ROOT}/src/index.ts",
    "--config", f"{ROOT}/demo/omp.yml",
    "--model", "anthropic/claude-sonnet-4-6",
    "--thinking", "low",
    "--no-skills", "--no-rules", "--no-lsp", "--hide-thinking",
])


class Session:
    def __init__(self) -> None:
        shutil.rmtree(WORK, ignore_errors=True)
        os.makedirs(WORK)
        os.chdir(WORK)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe("asciinema", [
                "asciinema", "rec", "--overwrite", "--quiet",
                "--output-format", "asciicast-v2",
                "--idle-time-limit", "3",
                "--window-size", f"{COLS}x{ROWS}",
                "--title", "omp-agenda demo",
                "--command", OMP,
                f"{WORK}/demo.cast",
            ], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.last_output = time.monotonic()

    def _drain(self, timeout: float) -> bool:
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return False
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            return False
        if data:
            self.last_output = time.monotonic()
        return bool(data)

    def pause(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._drain(max(0.0, min(0.1, end - time.monotonic())))

    def wait_idle(self, quiet: float = 3.0, limit: float = 240) -> None:
        """Wait until the screen stops changing: the working spinner redraws constantly until the agent is done."""
        start = time.monotonic()
        self.pause(1.0)
        while time.monotonic() - self.last_output < quiet and time.monotonic() - start < limit:
            self._drain(0.1)

    def keys(self, data: str) -> None:
        os.write(self.fd, data.encode())
        self.pause(0.15)

    def type(self, text: str, delay: float = 0.035) -> None:
        for char in text:
            os.write(self.fd, char.encode())
            self.pause(delay)

    def close(self) -> None:
        self.keys(CTRL_C)
        self.pause(0.5)
        self.keys(CTRL_C)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            self._drain(0.2)
            if os.waitpid(self.pid, os.WNOHANG)[0]:
                return


def main() -> None:
    s = Session()
    s.wait_idle()
    s.pause(1)

    # 1. Start a grilling session and ask for an agenda.
    s.type("I'm designing the caching layer for our product API. Grill me on it one question at a time, "
           "give your recommendation with each question, and pin an agenda so I can keep track. Keep replies short.")
    s.keys(ENTER)
    s.wait_idle()
    s.pause(2.5)

    # 2. Peek at the current topic's main points.
    s.keys(ALT_G)
    s.pause(4)
    s.keys(ALT_G)
    s.pause(1)

    # 3. Answer, referring to an item with the [ picker.
    s.type("For ")
    s.type("[")
    s.pause(2.5)
    s.keys(ENTER)
    s.type(" Redis, we already run it for sessions. Invalidate on write. Next question.")
    s.keys(ENTER)
    s.wait_idle()
    s.pause(2.5)

    # 4. One more answer, so the agenda has a few decisions.
    s.type("Agreed with your suggestion. Next.")
    s.keys(ENTER)
    s.wait_idle()
    s.pause(2.5)

    # 5. The full document, then the decisions page and back.
    s.keys(ALT_SHIFT_G)
    s.pause(3.5)
    s.keys("d")
    s.pause(4)
    s.keys("d")
    s.pause(1.5)
    s.keys("q")
    s.pause(2)

    s.close()
    # asciinema streams into the file as it records; on WSL's /mnt/c that can leave NUL holes, so
    # record inside the Linux filesystem and copy the finished file.
    shutil.copyfile(f"{WORK}/demo.cast", OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
