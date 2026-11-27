"""The configure verb: writes a whole configuration from its arguments and the defaults, and verifies it.

It reads no existing file, so a configuration the loader refuses is repaired by writing a new one,
and there is no read path that tolerates a bad file. The arguments are validated by the loader's
own rules before anything is written, so a refused argument leaves the old file as it was.

The verify step then reads the file back through the loader and prints what it holds, and under
the gate, as `list_holders()` reads the slots, opens each of the family's lock files and tries it
without blocking, so a slot another run holds is reported held and never waited for. A family
whose lock files cannot be opened fails the verb, after the configuration is written.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass
from typing import Dict, Optional, TextIO

from broker import protocol
from broker.errors import StateError
from broker.family import Family
from broker.files import write_whole
from broker.settings import Config, load_config


@dataclass(frozen=True)
class Settings:
    """The arguments of the verb, one per setting, and None for each that was not given."""

    family: Optional[str] = None
    shared: Optional[bool] = None
    max_runs: Optional[int] = None
    slots: Optional[int] = None
    settle_seconds: Optional[int] = None
    min_idle_percent: Optional[int] = None

    def given(self) -> Dict[str, object]:
        return {k: v for k, v in dataclasses.asdict(self).items() if v is not None}


def configure(root: str, settings: Settings, cores: int, out: TextIO) -> Config:
    """Writes the root's configuration, verifies it, reports on `out`, and returns it."""
    config = Config.from_mapping(settings.given(), root, cores)
    path = os.path.join(root, protocol.CONFIG_FILE)
    try:
        write_whole(path, config.to_json())
    except OSError as err:
        raise StateError(f"cannot write {path}: {err.strerror or err}") from err
    loaded = load_config(root, cores)
    if not loaded.configured or loaded.config != config:
        raise StateError(f"{path} read back differently from what was written")
    _report(path, config, out)
    _try_lock_files(config, out)
    return config


def _report(path: str, config: Config, out: TextIO) -> None:
    print(f"wrote {path}", file=out)
    print(f"family: {config.family}", file=out)
    print(f"shared with sim-lock.sh: {'yes' if config.shared else 'no'}", file=out)
    print(f"slots: {config.slots}", file=out)
    print(f"max runs: {config.max_runs}", file=out)
    print(f"settle seconds: {config.settle_seconds}", file=out)
    print(f"minimum idle percent: {config.min_idle_percent}", file=out)


def _try_lock_files(config: Config, out: TextIO) -> None:
    family = Family(
        config.family,
        slots=config.slots,
        window=config.window,
        creates_directory=not config.shared,
    )
    print("lock files, each opened and tried without blocking:", file=out)
    with family.gate():
        print(f"  {family.gate_path}: opened", file=out)
        for slot in range(family.window):
            state = "held" if family.probe(slot) else "free"
            print(f"  {family.slot_path(slot)}: {state}", file=out)
