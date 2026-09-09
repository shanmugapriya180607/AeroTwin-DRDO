"""
CAN / SocketCAN telemetry interface - the deployment path.

On a real aircraft the ECU/FADEC publishes engine parameters on the vehicle
CAN bus. This module implements that path with ``python-can`` over SocketCAN
and is demonstrable without hardware over the ``vcan0`` virtual device:

    sudo modprobe vcan
    sudo ip link add dev vcan0 type vcan
    sudo ip link set up vcan0

The code path is real; only the wire is virtual. The frame encoding below is a
prototype mapping, not an aircraft-standard DBC - a production integration
would take the engine manufacturer's DBC file and change only ``FRAME_MAP``.

SocketCAN is Linux-only. On other platforms the source reports unavailable and
the twin runs from replay or the demo simulator instead.
"""

from __future__ import annotations

import os
import platform
import struct
from datetime import datetime, timezone

from .base import DataSource, SourceDescriptor, TelemetryFrame

CAN_CHANNEL = os.environ.get("AEROTWIN_CAN_CHANNEL", "vcan0")
CAN_BUSTYPE = os.environ.get("AEROTWIN_CAN_BUSTYPE", "socketcan")

# arbitration id -> (channel keys, struct format, scale factors, offsets)
FRAME_MAP: dict[int, tuple[tuple[str, ...], str, tuple[float, ...], tuple[float, ...]]] = {
    0x180: (("rpm", "map_inhg", "fuel_flow_gph"), ">HHH", (1.0, 100.0, 100.0), (0.0, 0.0, 0.0)),
    0x181: (("egt_1", "egt_2", "egt_3", "egt_4"), ">HHHH", (10.0, 10.0, 10.0, 10.0), (0, 0, 0, 0)),
    0x182: (("cht_1", "cht_2", "cht_3", "cht_4"), ">HHHH", (10.0, 10.0, 10.0, 10.0), (0, 0, 0, 0)),
    0x183: (("oil_press_psi", "oil_temp_c", "oat_c"), ">HHh", (10.0, 10.0, 10.0), (0.0, 0.0, 0.0)),
    0x184: (("altitude_ft", "ias_kt"), ">iH", (1.0, 10.0), (0.0, 0.0)),
}


def encode(channel_values: dict[str, float]) -> list[tuple[int, bytes]]:
    """Encode a telemetry frame into CAN messages (used by the bench publisher)."""
    messages: list[tuple[int, bytes]] = []
    for can_id, (keys, fmt, scales, offsets) in FRAME_MAP.items():
        if not all(k in channel_values for k in keys):
            continue
        raw = [
            int(round((channel_values[k] + off) * scale))
            for k, scale, off in zip(keys, scales, offsets)
        ]
        try:
            messages.append((can_id, struct.pack(fmt, *raw)))
        except struct.error:
            continue
    return messages


def decode(can_id: int, data: bytes) -> dict[str, float]:
    spec = FRAME_MAP.get(can_id)
    if spec is None:
        return {}
    keys, fmt, scales, offsets = spec
    if len(data) < struct.calcsize(fmt):
        return {}
    values = struct.unpack(fmt, data[: struct.calcsize(fmt)])
    return {k: v / s - o for k, v, s, o in zip(keys, values, scales, offsets)}


def _probe() -> tuple[bool, str]:
    if platform.system() != "Linux":
        return False, (
            f"SocketCAN is Linux-only; this host is {platform.system()}. The "
            "interface is implemented and exercised by the unit tests, but the "
            "live path cannot be opened here."
        )
    try:
        import can  # type: ignore  # noqa: F401
    except ImportError:
        return False, "python-can is not installed. pip install python-can"
    return True, f"python-can over SocketCAN, device {CAN_CHANNEL}"


class SocketCanSource(DataSource):
    """Live engine telemetry from the vehicle CAN bus."""

    def __init__(self, timeout_s: float = 2.0) -> None:
        self._bus = None
        self._timeout = timeout_s
        self._t = 0.0
        self._pending: dict[str, float] = {}

    @property
    def descriptor(self) -> SourceDescriptor:
        ok, detail = _probe()
        return SourceDescriptor(
            id="CAN_LIVE",
            label=f"CAN / {CAN_CHANNEL}",
            kind="LIVE",
            provenance="REAL",
            available=ok,
            detail=detail,
        )

    def open(self, **kwargs) -> None:
        import can  # type: ignore

        self._bus = can.interface.Bus(channel=CAN_CHANNEL, bustype=CAN_BUSTYPE)
        self._t = 0.0

    def read(self) -> TelemetryFrame | None:
        if self._bus is None:
            return None
        collected: dict[str, float] = dict(self._pending)
        deadline_frames = 0
        while deadline_frames < 64:
            msg = self._bus.recv(timeout=self._timeout)
            if msg is None:
                break
            collected.update(decode(msg.arbitration_id, bytes(msg.data)))
            deadline_frames += 1
            if all(k in collected for k in ("rpm", "cht_1", "cht_4", "oil_press_psi")):
                break
        if "rpm" not in collected:
            return None
        self._pending = {}
        t = self._t
        self._t += 1.0
        from .ngafid import _infer_mixture, _infer_phase, _invert_throttle

        alt = collected.get("altitude_ft", 0.0)
        return TelemetryFrame(
            t=t,
            wall_clock=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            flight_id="CAN-LIVE",
            source_id="CAN_LIVE",
            phase=_infer_phase(alt, collected.get("rpm", 0.0), collected.get("ias_kt", 0.0)),
            channels=collected,
            inputs={
                "throttle": _invert_throttle(collected.get("map_inhg", 20.0), alt,
                                             collected.get("rpm", 2400.0)),
                "mixture": _infer_mixture(collected.get("fuel_flow_gph", 8.0),
                                          collected.get("rpm", 2400.0),
                                          collected.get("map_inhg", 20.0)),
                "altitude_ft": alt,
                "oat_c": collected.get("oat_c", 15.0),
                "ias_kt": collected.get("ias_kt", 0.0),
                "progress": 0.0,
            },
        )

    def close(self) -> None:
        if self._bus is not None:
            self._bus.shutdown()
            self._bus = None
