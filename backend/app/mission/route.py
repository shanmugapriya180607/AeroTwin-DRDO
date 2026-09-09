"""
Mission route and tactical picture.

Deliberately a fictional training area. No real installation, no real
coordinates: positions are reported as a local sector grid reference, not as
latitude and longitude, so nothing here can be read as an operational location.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SECTOR_NAME = "TRAINING SECTOR ALPHA"
SECTOR_CLASSIFICATION = "UNCLASSIFIED / TRAINING"
SECTOR_EXTENT_KM = (0.0, 0.0, 220.0, 190.0)   # x0, y0, x1, y1


@dataclass(frozen=True)
class Waypoint:
    id: str
    label: str
    x: float          # km east of sector origin
    y: float          # km north of sector origin
    kind: str         # BASE | WAYPOINT | ISR | RECOVERY
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "x": self.x,
            "y": self.y,
            "kind": self.kind,
            "note": self.note,
            "grid": grid_ref(self.x, self.y),
        }


WAYPOINTS: list[Waypoint] = [
    Waypoint("BASE", "BASE ALPHA", 18.0, 22.0, "BASE", "Launch and recovery airfield"),
    Waypoint("WP-01", "WP-01", 48.0, 74.0, "WAYPOINT", "Climb gate"),
    Waypoint("WP-02", "WP-02", 104.0, 118.0, "WAYPOINT", "Transit turn"),
    Waypoint("ISR", "ISR ZONE", 168.0, 144.0, "ISR", "Surveillance orbit, 18 km radius"),
    Waypoint("WP-03", "WP-03", 112.0, 66.0, "WAYPOINT", "Egress turn"),
    Waypoint("RTB", "RTB GATE", 46.0, 34.0, "RECOVERY", "Recovery gate"),
]

WAYPOINT_BY_ID = {w.id: w for w in WAYPOINTS}
ISR_ORBIT_RADIUS_KM = 18.0

# Which route leg each mission phase flies.
PHASE_LEG = {
    "GROUND": ("BASE", "BASE"),
    "TAKEOFF": ("BASE", "WP-01"),
    "CLIMB": ("BASE", "WP-01"),
    "TRANSIT": ("WP-01", "ISR"),
    "ISR LOITER": ("ISR", "ISR"),
    "RTB": ("ISR", "WP-03"),
    "DESCENT": ("WP-03", "RTB"),
    "APPROACH": ("RTB", "BASE"),
}


def grid_ref(x: float, y: float) -> str:
    """Local sector grid reference. Fictional training grid, not geographic."""
    return f"AL {int(round(x * 10)):04d} {int(round(y * 10)):04d}"


def route_polyline() -> list[dict]:
    """The planned route as an ordered list of points, including the orbit."""
    points: list[dict] = []
    for wp_id in ("BASE", "WP-01", "WP-02", "ISR"):
        wp = WAYPOINT_BY_ID[wp_id]
        points.append({"x": wp.x, "y": wp.y, "id": wp.id})
    for step in range(0, 37):
        angle = 2.0 * math.pi * step / 36.0
        isr = WAYPOINT_BY_ID["ISR"]
        points.append({
            "x": isr.x + ISR_ORBIT_RADIUS_KM * math.cos(angle),
            "y": isr.y + ISR_ORBIT_RADIUS_KM * math.sin(angle),
            "id": "ORBIT",
        })
    for wp_id in ("WP-03", "RTB", "BASE"):
        wp = WAYPOINT_BY_ID[wp_id]
        points.append({"x": wp.x, "y": wp.y, "id": wp.id})
    return points


def orbit_ring() -> list[dict]:
    isr = WAYPOINT_BY_ID["ISR"]
    return [
        {
            "x": isr.x + ISR_ORBIT_RADIUS_KM * math.cos(2 * math.pi * i / 48),
            "y": isr.y + ISR_ORBIT_RADIUS_KM * math.sin(2 * math.pi * i / 48),
        }
        for i in range(49)
    ]


def position_at(phase: str, phase_progress: float, mission_elapsed_s: float) -> dict:
    """UAV position for a mission phase and the fraction completed within it."""
    start_id, end_id = PHASE_LEG.get(phase, ("BASE", "BASE"))
    start = WAYPOINT_BY_ID[start_id]
    end = WAYPOINT_BY_ID[end_id]
    u = max(0.0, min(1.0, phase_progress))

    if phase == "ISR LOITER":
        isr = WAYPOINT_BY_ID["ISR"]
        # One orbit every 22 minutes of mission time.
        angle = 2.0 * math.pi * (mission_elapsed_s % 1320.0) / 1320.0
        x = isr.x + ISR_ORBIT_RADIUS_KM * math.cos(angle)
        y = isr.y + ISR_ORBIT_RADIUS_KM * math.sin(angle)
        heading = math.degrees(angle + math.pi / 2.0) % 360.0
        leg = "ISR ORBIT"
    elif phase == "TRANSIT":
        # Transit routes via WP-02 rather than direct.
        mid = WAYPOINT_BY_ID["WP-02"]
        if u < 0.5:
            x = _lerp(start.x, mid.x, u * 2.0)
            y = _lerp(start.y, mid.y, u * 2.0)
            heading = _bearing(start.x, start.y, mid.x, mid.y)
            leg = "WP-01 → WP-02"
        else:
            v = (u - 0.5) * 2.0
            x = _lerp(mid.x, end.x, v)
            y = _lerp(mid.y, end.y, v)
            heading = _bearing(mid.x, mid.y, end.x, end.y)
            leg = "WP-02 → ISR ZONE"
    else:
        x = _lerp(start.x, end.x, u)
        y = _lerp(start.y, end.y, u)
        heading = (
            _bearing(start.x, start.y, end.x, end.y)
            if (start.x, start.y) != (end.x, end.y) else 45.0
        )
        leg = f"{start.label} → {end.label}" if start.id != end.id else start.label

    return {
        "x": round(x, 3),
        "y": round(y, 3),
        "heading": round(heading, 1),
        "leg": leg,
        "grid": grid_ref(x, y),
        "distance_to_base_km": round(math.hypot(x - 18.0, y - 22.0), 1),
    }


def sector() -> dict:
    return {
        "name": SECTOR_NAME,
        "classification": SECTOR_CLASSIFICATION,
        "extent_km": SECTOR_EXTENT_KM,
        "note": (
            "Fictional training area. Positions are reported as a local sector "
            "grid reference. No operational location is represented."
        ),
        "waypoints": [w.as_dict() for w in WAYPOINTS],
        "route": route_polyline(),
        "orbit": orbit_ring(),
        "orbit_radius_km": ISR_ORBIT_RADIUS_KM,
    }


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def _bearing(x0: float, y0: float, x1: float, y1: float) -> float:
    return math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360.0
