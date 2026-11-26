"""Small programs the process tests run as the command of a metered run.

Each is the source of a Python program, run as `python -c SOURCE args...`. They write the ids and
marks the tests read, to files named in their arguments, so a test learns a process id from the
process itself and kills only ids it was given.
"""

from __future__ import annotations

# Writes its pid to argv[1], then waits until the file argv[2] exists, and exits 0.
WAIT_FOR_RELEASE = (
    "import os, sys, time\n"
    "with open(sys.argv[1], 'w') as handle:\n"
    "    handle.write(str(os.getpid()))\n"
    "while not os.path.exists(sys.argv[2]):\n"
    "    time.sleep(0.05)\n"
)

# Exits with the status in argv[1].
EXIT_WITH = "import sys\nsys.exit(int(sys.argv[1]))\n"

# Starts a background process that outlives it, writes that process's pid to argv[1], and exits 0.
# The daemon has no stream of the command's, as a daemon should not, so it holds no pipe open, but
# it inherits every other descriptor the command has, as one a shell starts does: so it holds the
# slot exactly when the command was given it.
LEAVE_A_DAEMON = (
    "import subprocess, sys\n"
    "daemon = subprocess.Popen(\n"
    "    ['/bin/sleep', '60'], start_new_session=True, close_fds=False, stdin=subprocess.DEVNULL,\n"
    "    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
    "with open(sys.argv[1], 'w') as handle:\n"
    "    handle.write(str(daemon.pid))\n"
)

# Writes its pid to argv[1], traps TERM, HUP and INT by writing the signal number to argv[2], and
# exits 3 once one arrives.
RECORD_A_SIGNAL = (
    "import os, signal, sys, time\n"
    "def caught(signum, frame):\n"
    "    with open(sys.argv[2], 'w') as handle:\n"
    "        handle.write(str(signum))\n"
    "    sys.exit(3)\n"
    "for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):\n"
    "    signal.signal(sig, caught)\n"
    "with open(sys.argv[1], 'w') as handle:\n"
    "    handle.write(str(os.getpid()))\n"
    "while True:\n"
    "    time.sleep(0.05)\n"
)

# Runs far past a short run limit. Its TERM trap writes the mark in argv[2], and it then exits 5,
# which the run limit's 124 replaces. Writes its pid to argv[1] and starts a grandchild that
# ignores TERM, whose pid it writes to argv[3].
TRAP_TERM_WITH_A_STUBBORN_GRANDCHILD = (
    "import os, signal, subprocess, sys, time\n"
    "grandchild = subprocess.Popen(\n"
    "    [sys.executable, '-c',\n"
    "     'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n'\n"
    "     'while True: time.sleep(0.05)'])\n"
    "def term(signum, frame):\n"
    "    with open(sys.argv[2], 'w') as handle:\n"
    "        handle.write('term')\n"
    "    sys.exit(5)\n"
    "signal.signal(signal.SIGTERM, term)\n"
    "with open(sys.argv[3], 'w') as handle:\n"
    "    handle.write(str(grandchild.pid))\n"
    "with open(sys.argv[1], 'w') as handle:\n"
    "    handle.write(str(os.getpid()))\n"
    "while True:\n"
    "    time.sleep(0.05)\n"
)

# Ignores TERM and never exits by itself: only the KILL after the grace period ends it. Writes its
# pid to argv[1].
IGNORE_TERM = (
    "import os, signal, sys, time\n"
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "with open(sys.argv[1], 'w') as handle:\n"
    "    handle.write(str(os.getpid()))\n"
    "while True:\n"
    "    time.sleep(0.05)\n"
)

# Writes argv[1] to the file argv[2], so a test can tell that the command ran.
LEAVE_A_MARK = (
    "import sys\n"
    "with open(sys.argv[2], 'w') as handle:\n"
    "    handle.write(sys.argv[1])\n"
)
