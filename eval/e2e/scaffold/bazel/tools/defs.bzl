"""Shared macros and rules."""

load("@rules_python//python:defs.bzl", "py_test")

def storefront_py_test(name, **kwargs):
    """py_test with the repo's defaults (small unless told otherwise)."""
    kwargs.setdefault("size", "small")
    py_test(name = name, **kwargs)
