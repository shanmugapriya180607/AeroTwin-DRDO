"""
The data source contract.

This module is the architectural centrepiece of the deployment answer: NGAFID
replay, the demo telemetry simulator and live CAN telemetry all implement the
*same* interface and emit the *same* frame shape. Everything downstream - the
physics lockstep, the residual engine, the analytics and the dashboard - is
written against this contract and never against a particular source.

Swapping in DRDO / VRDE test-rig data means implementing one class here.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Iterator, Literal

from ..core.constants import CHANNEL_BY_KEY

SourceKind = Literal["REPLAY", "SYNTHETIC", "LIVE"]


@dataclass(slots=True)
class TelemetryFrame:
    """One 1 Hz sample as it arrives from any source."""

    t: float                       # mission elapsed seconds
    wall_clock: str                # ISO-8601 timestamp
    flight_id: str
    source_id: str
    phase: str
    channels: dict[str, float]     # sensor readings, keyed by channel id
    inputs: dict[str, float]       # control + ambient inputs shared with the twin
    provenance: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.provenance:
            self.provenance = {
                k: CHANNEL_BY_KEY[k]["provenance"]
                for k in self.channels
                if k in CHANNEL_BY_KEY
            }


@dataclass(frozen=True)
class SourceDescriptor:
    id: str
    label: str
    kind: SourceKind
    provenance: str
    available: bool
    detail: str
    rate_hz: float = 1.0


class DataSource(abc.ABC):
    """Any telemetry origin the twin can be driven by."""

    @property
    @abc.abstractmethod
    def descriptor(self) -> SourceDescriptor: ...

    @abc.abstractmethod
    def open(self, **kwargs) -> None: ...

    @abc.abstractmethod
    def read(self) -> TelemetryFrame | None:
        """Return the next 1 Hz frame, or None when the stream is exhausted."""

    def close(self) -> None:  # pragma: no cover - trivial default
        return None

    def stream(self, limit: int | None = None) -> Iterator[TelemetryFrame]:
        count = 0
        while limit is None or count < limit:
            frame = self.read()
            if frame is None:
                return
            count += 1
            yield frame


class ThermalLag:
    """First-order thermal inertia.

    Cylinder heads and oil do not follow a power change instantly. Both the
    observed engine and the physics expectation are filtered with the same
    time constants, so a throttle transient does not manufacture a residual.
    """

    def __init__(self, tau_s: dict[str, float]) -> None:
        self.tau = tau_s
        self.state: dict[str, float] = {}

    def apply(self, values: dict[str, float], dt: float = 1.0) -> dict[str, float]:
        out = dict(values)
        for key, tau in self.tau.items():
            if key not in values:
                continue
            target = values[key]
            prev = self.state.get(key)
            if prev is None:
                self.state[key] = target
                continue
            alpha = 1.0 - pow(2.718281828, -dt / max(1e-3, tau))
            new = prev + alpha * (target - prev)
            self.state[key] = new
            out[key] = new
        return out

    def reset(self) -> None:
        self.state.clear()


DEFAULT_LAG_TAU = {
    "cht_1": 34.0, "cht_2": 34.0, "cht_3": 34.0, "cht_4": 34.0,
    "egt_1": 7.0, "egt_2": 7.0, "egt_3": 7.0, "egt_4": 7.0,
    "oil_temp_c": 150.0,
    "oil_press_psi": 4.0,
}
