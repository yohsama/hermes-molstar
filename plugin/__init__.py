"""Agent-side registration stub for the unified Hermes Mol* package.

V1 registers no tools or hooks. Its skill teaches the directive syntax and its
dashboard router performs the separately gated, authorized structure read.
"""


def register(ctx):
    """Hermes unified-plugin entry point; intentionally contributes no tools."""
    del ctx
