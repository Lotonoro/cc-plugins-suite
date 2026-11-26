"""The configuration: its defaults, its validation, and the file a state root loads it from.

`config.json` in a state root is a JSON object holding any of the settings in
`protocol.CONFIG_KEYS`. A setting the file leaves out takes its default, so an empty object is a
root with no configuration at all. The file is validated here, where it is loaded, and nowhere
else; the `configure` verb writes a complete one.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

from broker import protocol
from broker.errors import ConfigError


def default_family(root: str) -> str:
    """The broker's own family, which a root with no family configured uses."""
    return os.path.join(root, protocol.FAMILY_DIRECTORY, protocol.FAMILY_FILE)


def default_slots(cores: int, shared: bool, max_runs: int) -> int:
    """The slot count when none is set: max(3, cores / 4), capped at MAX_RUNS on a shared family."""
    wanted = max(protocol.SLOT_FLOOR, cores // protocol.CORES_PER_SLOT)
    return min(max_runs, wanted) if shared else wanted


def _whole(key: str, value: object, minimum: int, maximum: Optional[int], what: str) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        raise ConfigError(f"{key} must be {what}, not {value!r}")
    return value


def _flag(key: str, value: object) -> bool:
    if type(value) is not bool:
        raise ConfigError(f"{key} must be true or false, not {value!r}")
    return value


def _positive(key: str, value: object) -> int:
    return _whole(key, value, 1, None, "a positive whole number")


@dataclass(frozen=True)
class Config:
    """A state root's settings.

    `slots` is the broker's own count, c. On a family `shared` with `sim-lock.sh`, `max_runs` is
    the MAX_RUNS that the script's callers use, N, which c may not pass; on any other family it
    is not read. Every default is written in `defaults`, the one path to them, so a field has none
    of its own.
    """

    family: str
    slots: int
    shared: bool
    max_runs: int
    settle_seconds: int
    min_idle_percent: int

    @classmethod
    def defaults(
        cls,
        root: str,
        cores: int,
        shared: bool = False,
        max_runs: int = protocol.DEFAULT_MAX_RUNS,
    ) -> "Config":
        """The settings of a root that sets none, or only `shared` and `max_runs`.

        The default slot count depends on those two, so a configuration that sets either asks here
        for the defaults they imply.
        """
        return cls(
            family=default_family(root),
            slots=default_slots(cores, shared, max_runs),
            shared=shared,
            max_runs=max_runs,
            settle_seconds=protocol.DEFAULT_SETTLE_SECONDS,
            min_idle_percent=protocol.DEFAULT_MIN_IDLE_PERCENT,
        )

    @classmethod
    def from_mapping(cls, data: object, root: str, cores: int) -> "Config":
        """The configuration `data` describes over the defaults for `root` and a machine of `cores`.

        Raises ConfigError for anything that is not a complete, valid description.
        """
        if not isinstance(data, dict):
            raise ConfigError("the configuration must be a JSON object")
        unknown = sorted(str(key) for key in data if key not in protocol.CONFIG_KEYS)
        if unknown:
            raise ConfigError("unknown setting " + ", ".join(unknown))
        plain = cls.defaults(root, cores)
        shared = _flag(protocol.KEY_SHARED, data.get(protocol.KEY_SHARED, plain.shared))
        max_runs = _positive(protocol.KEY_MAX_RUNS, data.get(protocol.KEY_MAX_RUNS, plain.max_runs))
        base = cls.defaults(root, cores, shared, max_runs)
        config = cls(
            family=data.get(protocol.KEY_FAMILY, base.family),
            slots=data.get(protocol.KEY_SLOTS, base.slots),
            shared=shared,
            max_runs=max_runs,
            settle_seconds=data.get(protocol.KEY_SETTLE, base.settle_seconds),
            min_idle_percent=data.get(protocol.KEY_MIN_IDLE, base.min_idle_percent),
        )
        config.validate()
        return config

    def validate(self) -> None:
        """Raises ConfigError unless the settings `from_mapping` has not checked are in range and all agree.

        `shared` and `max_runs` are checked where `from_mapping` reads them, since the default slot
        count needs them.
        """
        if type(self.family) is not str or not os.path.isabs(self.family):
            raise ConfigError(f"family must be an absolute path, not {self.family!r}")
        _positive(protocol.KEY_SLOTS, self.slots)
        if self.shared and self.slots > self.max_runs:
            raise ConfigError(
                f"slots is {self.slots}, more than the MAX_RUNS {self.max_runs} that "
                "sim-lock.sh's callers use on this shared family"
            )
        _whole(
            protocol.KEY_SETTLE,
            self.settle_seconds,
            0,
            protocol.MAX_SETTLE_SECONDS,
            "a whole number of at most 7 digits",
        )
        _whole(
            protocol.KEY_MIN_IDLE,
            self.min_idle_percent,
            0,
            protocol.MAX_MIN_IDLE_PERCENT,
            "a whole number of at most 3 digits",
        )

    @property
    def window(self) -> int:
        """How many slots the alone check and the holder listing look at: N on a shared family."""
        return self.max_runs if self.shared else self.slots

    def to_json(self) -> str:
        """The file's text: every setting, in `protocol.CONFIG_KEYS` order, ending in a newline."""
        return (
            json.dumps(
                {
                    protocol.KEY_FAMILY: self.family,
                    protocol.KEY_SHARED: self.shared,
                    protocol.KEY_MAX_RUNS: self.max_runs,
                    protocol.KEY_SLOTS: self.slots,
                    protocol.KEY_SETTLE: self.settle_seconds,
                    protocol.KEY_MIN_IDLE: self.min_idle_percent,
                },
                indent=2,
            )
            + "\n"
        )


@dataclass(frozen=True)
class LoadedConfig:
    config: Config
    configured: bool  # False when the root holds no config.json and the defaults stand


def load_config(root: str, cores: int) -> LoadedConfig:
    """The configuration of the state root `root`, validated; defaults when it holds none."""
    path = os.path.join(root, protocol.CONFIG_FILE)
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return LoadedConfig(Config.defaults(root, cores), configured=False)
    except OSError as err:
        raise ConfigError(f"cannot read {path}: {err.strerror or err}") from err
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as err:  # UnicodeDecodeError and json.JSONDecodeError are both ValueErrors
        raise ConfigError(f"{path} is not JSON: {err}") from err
    try:
        config = Config.from_mapping(data, root, cores)
    except ConfigError as err:
        raise ConfigError(f"{path}: {err}") from err
    return LoadedConfig(config, configured=True)
