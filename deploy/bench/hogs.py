"""Test-only job functions run inside the container by hog_runner.py (mounted, never shipped)."""

import time


def touch(megabytes: int) -> int:
    """Allocate memory a megabyte at a time and write to every page so it is resident.

    Bounded by the caller (a few hundred megabytes at most). A short pause between steps lets the
    sampler and the kernel act, as a slowly growing real job would.
    """
    blocks = []
    for _ in range(megabytes):
        block = bytearray(1024 * 1024)
        for offset in range(0, len(block), 4096):
            block[offset] = 1
        blocks.append(block)
        if len(blocks) % 16 == 0:
            time.sleep(0.01)
    return len(blocks)
