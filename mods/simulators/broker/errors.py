"""The failures a client command reports and exits on, each with its published exit code.

A module that cannot proceed raises one of these; the dispatcher alone turns it into a line on
stderr and an exit status, so no module decides how the process ends.
"""

from __future__ import annotations

from broker import protocol


class BrokerError(Exception):
    """A refusal before or instead of a run. `exit_code` is the status the client exits with."""

    exit_code = protocol.EXIT_CONFIG


class UsageError(BrokerError):
    """The command line is not one the client takes."""

    exit_code = protocol.EXIT_USAGE


class ConfigError(BrokerError, ValueError):
    """A configuration the loader refuses, or one that cannot be read."""


class FamilyError(BrokerError):
    """A lock file of the family cannot be opened or locked."""


class StateError(BrokerError):
    """A record in the state directory cannot be read or written."""


class FamilyDisagreement(BrokerError):
    """The family the client was given is not the family its state root names."""

    exit_code = protocol.EXIT_FAMILY_DISAGREES

    def __init__(self, configured: str, given: str, source: str) -> None:
        super().__init__(
            f"the family {given} that {protocol.FAMILY_VARIABLE} names is not the family "
            f"{configured} that {source} names; nothing was run"
        )
        self.configured = configured
        self.given = given
