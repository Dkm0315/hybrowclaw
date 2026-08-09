"""Deterministic, explicitly-invoked proof data for Muster."""


def seed_demo(**kwargs):
    from muster.demo.seed import seed_demo as _seed_demo

    return _seed_demo(**kwargs)


__all__ = ["seed_demo"]
