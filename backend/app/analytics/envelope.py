"""
Whether the physics model can be believed for the source currently connected.

This exists because of something the team corpus made visible the moment it was
put on the live seat. AEROTWIN's expectation is produced by a model calibrated
for a 180 hp, 2,700 rpm, four-cylinder air-cooled aero engine. Hand it a corpus
recorded from a different machine - one running at 4,800 rpm, with one bulk
temperature instead of eight cylinder thermocouples - and every residual is
enormous. The health index collapses to zero and the engine is reported
CRITICAL.

That number would be a lie. The residual is real, but it is a *model mismatch*
residual, not evidence of a fault: nothing has been observed about that engine
except that AEROTWIN's model was not built for it. Reporting a failing engine
from it is exactly the failure mode this system is supposed to be immune to.

So the twin checks the envelope first, and where the check fails it abstains and
says why, rather than diagnosing. Three verdicts:

  IN ENVELOPE     the model applies; diagnose normally
  REDUCED         the model applies, but the instrumentation is incomplete -
                  diagnose what is covered, and say what cannot be
  OUT OF ENVELOPE the operating point is outside what the model was calibrated
                  for; no diagnosis is offered at all
"""

from __future__ import annotations

from ..core.constants import ENGINE, RESIDUAL_CHANNELS

#: Per-cylinder channels. Without these there is nothing to localise a fault
#: to, however clear the bulk residual is.
CYLINDER_CHANNELS = tuple(
    f"{prefix}_{i}" for prefix in ("cht", "egt") for i in range(1, 5)
)

#: How far past rated speed the model is still trusted. Aero piston engines are
#: operated close to rated, and the volumetric-efficiency and cooling terms are
#: fitted over that band - not over an arbitrary one.
RPM_CEILING_FACTOR = 1.15
RPM_FLOOR_FACTOR = 0.4

#: Below this fraction of the residual channel set, the bulk diagnosis has too
#: little to stand on to be worth offering.
MIN_COVERAGE = 0.30


def envelope_status(
    channels: dict[str, float],
    inputs: dict[str, float] | None = None,
) -> dict:
    """Classify the current operating point against the model's calibration.

    Takes the observed channels rather than the expectation on purpose: the
    question is whether the *source* is something the model was built for, and
    the expectation is the thing under suspicion.
    """
    inputs = inputs or {}
    reasons: list[str] = []
    limits: list[dict] = []

    present = [key for key in RESIDUAL_CHANNELS if key in channels]
    coverage = len(present) / len(RESIDUAL_CHANNELS)
    missing = [key for key in RESIDUAL_CHANNELS if key not in channels]
    cylinder_coverage = sum(1 for key in CYLINDER_CHANNELS if key in channels)

    rated = float(ENGINE["rated_rpm"])
    idle = float(ENGINE["idle_rpm"])
    ceiling = rated * RPM_CEILING_FACTOR
    floor = idle * RPM_FLOOR_FACTOR

    out_of_envelope = False

    rpm = channels.get("rpm")
    if rpm is not None:
        limits.append({
            "quantity": "RPM", "value": round(rpm, 1),
            "min": round(floor, 0), "max": round(ceiling, 0),
            "within": floor <= rpm <= ceiling,
        })
        if rpm > ceiling:
            out_of_envelope = True
            reasons.append(
                f"Crankshaft speed {rpm:,.0f} rpm is above the model's calibrated "
                f"ceiling of {ceiling:,.0f} rpm ({ENGINE['reference_engine']}, "
                f"rated {rated:,.0f} rpm). This is a different class of engine."
            )
        elif rpm < floor and rpm > 0:
            out_of_envelope = True
            reasons.append(
                f"Crankshaft speed {rpm:,.0f} rpm is below the model's floor of "
                f"{floor:,.0f} rpm."
            )

    if coverage < MIN_COVERAGE:
        out_of_envelope = True
        reasons.append(
            f"Only {len(present)} of {len(RESIDUAL_CHANNELS)} residual channels are "
            "present in this source - too little to form a bulk diagnosis."
        )

    localisation = cylinder_coverage >= 4
    if not localisation:
        reasons.append(
            "This source has engine-level instrumentation only, so a finding "
            "cannot be attributed to a cylinder."
        )

    if out_of_envelope:
        state = "OUT OF ENVELOPE"
    elif not localisation or coverage < 1.0:
        state = "REDUCED"
    else:
        state = "IN ENVELOPE"

    return {
        "state": state,
        # The two gates the runtime actually consults.
        "diagnosis_permitted": not out_of_envelope,
        "localisation_permitted": localisation,
        # A health number computed from a mismatched model is not a health
        # number. The UI shows a dash rather than a zero.
        "health_valid": not out_of_envelope,
        "reasons": reasons,
        "summary": reasons[0] if reasons else "Source is within the model's calibration.",
        "coverage": {
            "present": len(present),
            "total": len(RESIDUAL_CHANNELS),
            "pct": round(100.0 * coverage, 1),
            "missing": missing,
            "cylinder_channels": cylinder_coverage,
        },
        "limits": limits,
        "model": {
            "reference_engine": ENGINE["reference_engine"],
            "rated_rpm": rated,
            "rated_power_hp": ENGINE["rated_power_hp"],
            "cylinders": ENGINE["cylinders"],
        },
    }
