"""Replacing a file whole: the one way the broker writes a record a reader must never see half of."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def write_whole(path: str, text: str) -> None:
    """Makes `text` the whole content of `path`: written under a temporary name, then renamed.

    A reader sees the old content or the new and never a torn file, and a crash leaves at most a
    stray temporary name that the next write replaces. The directory is made when it is missing.
    Raises OSError, with no temporary file left.
    """
    directory = os.path.dirname(path)
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    try:
        os.makedirs(directory, exist_ok=True)
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError as err:
            # Best effort, on a path that is already failing: the write's own error is the one
            # raised, and a stray temporary name is replaced by the next write.
            logger.debug("[FILES] cannot remove %s: %s", temporary, err)
        raise
