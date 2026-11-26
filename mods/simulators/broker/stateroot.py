"""The open step: a state root's configuration, checked against the family a client was given.

The root is a directory holding `config.json` and one state directory. Opening it loads and
validates the configuration, and when the dispatcher hands it a family, compares that with the
configuration's: a client whose environment names another family than its root's would run one
queue against two families, so it reports both and runs nothing.

It reads no environment and no clock: the dispatcher alone reads the client's environment and
hands this module the values, so every test of it runs with none.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from broker import protocol
from broker.decisions import DecisionStore
from broker.errors import FamilyDisagreement
from broker.family import Family
from broker.policy import Rules
from broker.settings import Config, LoadedConfig, load_config


@dataclass(frozen=True)
class Root:
    """An opened state root: where it is, and the configuration it runs on."""

    path: str
    loaded: LoadedConfig

    @property
    def config(self) -> Config:
        return self.loaded.config

    @property
    def configured(self) -> bool:
        return self.loaded.configured

    @property
    def config_path(self) -> str:
        return os.path.join(self.path, protocol.CONFIG_FILE)

    @property
    def state_dir(self) -> str:
        return os.path.join(self.path, protocol.STATE_DIRECTORY)

    def family(self) -> Family:
        """The lock family, whose directory the broker makes unless the family is shared."""
        return Family(
            self.config.family,
            slots=self.config.slots,
            window=self.config.window,
            creates_directory=not self.config.shared,
        )

    def rules(self) -> Rules:
        return Rules(
            slots=self.config.slots,
            window=self.config.window,
            settle_seconds=self.config.settle_seconds,
            min_idle_percent=self.config.min_idle_percent,
        )

    def decisions(self) -> DecisionStore:
        return DecisionStore(self.state_dir)

    def notice(self) -> Optional[str]:
        """The line a waiter prints once when the root has no configuration, and None otherwise."""
        if self.configured:
            return None
        return protocol.NOTICE_UNCONFIGURED.format(
            config=self.config_path, family=self.config.family
        )


def open_root(path: str, cores: int, given_family: Optional[str] = None) -> Root:
    """Opens the state root at `path`.

    `cores` sets the default slot count of a root with no configuration. `given_family` is the
    family the client was given, if any; one that is not the configuration's, once both are
    resolved, is a FamilyDisagreement.
    """
    loaded = load_config(path, cores)
    root = Root(path, loaded)
    if given_family is not None and os.path.realpath(given_family) != os.path.realpath(
        loaded.config.family
    ):
        source = root.config_path if loaded.configured else f"the state root {path}"
        raise FamilyDisagreement(loaded.config.family, given_family, source)
    return root
