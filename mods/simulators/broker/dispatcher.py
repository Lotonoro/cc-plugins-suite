"""The dispatcher: the client's one entry point, and the one reader of its environment.

Every verb enters here. The dispatcher reads the command line, then the environment, opens the
state root through the open step and hands the verb what it needs, and turns a refusal into a line
on stderr and an exit status. The modules below it read no environment, so a test of any of them
runs with none, and a new rule about an environment variable is an edit to this module alone.

`main` is handed the environment as a mapping, and `entry` is the one place the process's own is
read. A variable set to nothing counts as unset, as the shell's `${name:-default}` counts it.

A client that sets `SIM_LOCK_FILE` says which family it believes it is on, and a state root that
names another family runs nothing. Any other `SIM_LOCK_*` variable is a knob of `sim-lock.sh` that
the broker does not read, and a line says so. The configure verb takes the family as an option and
reads no state root, so for it `SIM_LOCK_FILE` is one more knob that is ignored.

A command line that is wrong is refused before the environment is read, and an unexpected failure
is not caught here: it ends the process with its traceback, which is how a bug should look.
"""

from __future__ import annotations

import argparse
import os
import pwd
import sys
from dataclasses import dataclass
from typing import Mapping, NoReturn, Optional, Sequence, TextIO, Tuple

from broker import protocol
from broker.clock import Clock, SystemClock
from broker.configure import Settings, configure
from broker.errors import BrokerError, UsageError
from broker.leaf import Applicant
from broker.machine import Machine, MachineAdapter
from broker.runner import metered_run
from broker.stateroot import Root, open_root
from broker.status import status
from broker.waiter import Waiter

USAGE = f"""\
usage: broker run [--] COMMAND [ARGUMENT...]
       broker configure [--family PATH] [--shared] [--max-runs N] [--slots N]
                        [--settle-seconds N] [--min-idle-percent N]
       broker status
       broker help

  run        wait for a simulator run slot, run COMMAND under it, and exit with its status
  configure  write the state root's whole configuration from these options and the defaults,
             then read it back and try its lock files
  status     print the state root, its family and the last admission decision

The state root is the directory that {protocol.STATE_ROOT_SETTING} names, and by default
~/{os.path.join(*protocol.DEFAULT_ROOT_PARTS)}.
"""


@dataclass(frozen=True)
class Request:
    """A command line, parsed: the verb, and what the verb was given."""

    verb: str
    command: Tuple[str, ...] = ()
    settings: Settings = Settings()


@dataclass(frozen=True)
class Environment:
    """What the dispatcher read: the state root, the family the client was given, what it ignores."""

    state_root: str
    family: Optional[str]
    ignored: Tuple[str, ...]


class _OptionParser(argparse.ArgumentParser):
    """An argument parser whose refusals are usage errors, so it never exits the process itself."""

    def error(self, message: str) -> NoReturn:
        raise UsageError(message)


def main(
    argv: Sequence[str],
    environ: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    machine: MachineAdapter,
    clock: Clock,
) -> int:
    """Runs one verb and returns the process's exit status."""
    try:
        request = _parse(argv)
        if request.verb == protocol.VERB_HELP:
            out.write(USAGE)
            return 0
        return _dispatch(request, environ, out, err, machine, clock)
    except UsageError as error:
        err.write(protocol.MESSAGE_PREFIX + str(error) + "\n" + USAGE)
        return error.exit_code
    except BrokerError as error:
        err.write(protocol.MESSAGE_PREFIX + str(error) + "\n")
        return error.exit_code


def entry() -> int:
    """The process's entry: its own environment and streams, the real machine and clock."""
    return main(sys.argv[1:], os.environ, sys.stdout, sys.stderr, Machine(), SystemClock())


def _parse(argv: Sequence[str]) -> Request:
    if not argv:
        raise UsageError("no verb given")
    verb, arguments = argv[0], list(argv[1:])
    if verb == protocol.VERB_HELP or verb in protocol.HELP_FLAGS:
        return Request(protocol.VERB_HELP)
    if verb == protocol.VERB_RUN:
        if arguments[:1] == ["--"]:
            arguments = arguments[1:]
        if not arguments:
            raise UsageError("run needs a command")
        return Request(verb, command=tuple(arguments))
    if verb == protocol.VERB_STATUS:
        if arguments:
            raise UsageError("status takes no argument")
        return Request(verb)
    if verb == protocol.VERB_CONFIGURE:
        return Request(verb, settings=_settings(arguments))
    raise UsageError(f"unknown verb {verb!r}")


def _settings(arguments: Sequence[str]) -> Settings:
    """The configure verb's options, one per setting, named as the configuration names them."""
    parser = _OptionParser(add_help=False, allow_abbrev=False)
    for key in protocol.CONFIG_KEYS:
        flag = "--" + key.replace("_", "-")
        if key == protocol.KEY_SHARED:
            parser.add_argument(flag, dest=key, action="store_true", default=None)
        elif key == protocol.KEY_FAMILY:
            parser.add_argument(flag, dest=key)
        else:
            parser.add_argument(flag, dest=key, type=int)
    return Settings(**vars(parser.parse_args(arguments)))


def _dispatch(
    request: Request,
    environ: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    machine: MachineAdapter,
    clock: Clock,
) -> int:
    configuring = request.verb == protocol.VERB_CONFIGURE
    environment = _read(environ, takes_family=not configuring)
    if environment.ignored:
        names = ", ".join(environment.ignored)
        err.write(protocol.LINE_IGNORED.format(names=names) + "\n")
    cores = machine.cores()
    if configuring:
        configure(environment.state_root, request.settings, cores, out)
        return 0
    root = open_root(environment.state_root, cores, environment.family)
    if request.verb == protocol.VERB_STATUS:
        status(root, out)
        return 0
    return _run(root, request.command, _working_directory(environ), err, machine, clock)


def _read(environ: Mapping[str, str], takes_family: bool) -> Environment:
    """The environment's part in a verb: the root, the family the verb takes, and the knobs it ignores."""
    setting = _value(environ, protocol.STATE_ROOT_SETTING)
    state_root = os.path.abspath(setting or _default_root(environ))
    family = _value(environ, protocol.FAMILY_VARIABLE) if takes_family else None
    ignored = sorted(
        name
        for name, value in environ.items()
        if value
        and name.startswith(protocol.IGNORED_VARIABLE_PREFIX)
        and not (takes_family and name == protocol.FAMILY_VARIABLE)
    )
    return Environment(state_root, family, tuple(ignored))


def _value(environ: Mapping[str, str], name: str) -> Optional[str]:
    return environ.get(name) or None


def _default_root(environ: Mapping[str, str]) -> str:
    home = _value(environ, protocol.HOME_VARIABLE) or pwd.getpwuid(os.getuid()).pw_dir
    return os.path.join(home, *protocol.DEFAULT_ROOT_PARTS)


def _working_directory(environ: Mapping[str, str]) -> str:
    """The directory a run records as its own: `$PWD` when it names the current directory.

    `sim-lock.sh` records its shell's `$PWD`, which keeps the symlinks the caller went through,
    where `os.getcwd()` resolves them. A shell trusts `$PWD` only when it is an absolute path to
    the directory it is in, and so does this; any other `$PWD` is stale, and the current directory
    stands in.
    """
    current = os.getcwd()
    named = _value(environ, protocol.PWD_VARIABLE)
    if named is not None and os.path.isabs(named):
        try:
            if os.path.samefile(named, current):
                return named
        except OSError:
            pass  # the path is not there or cannot be read: it names no directory
    return current


def _run(
    root: Root,
    command: Sequence[str],
    directory: str,
    err: TextIO,
    machine: MachineAdapter,
    clock: Clock,
) -> int:
    waiter = Waiter(root.leaf(machine, clock), clock, err, notice=root.notice())
    applicant = Applicant(pid=os.getpid(), cwd=directory, command=command)
    return metered_run(waiter, applicant)


if __name__ == "__main__":
    sys.exit(entry())
