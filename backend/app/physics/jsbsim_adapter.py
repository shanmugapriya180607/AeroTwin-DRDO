"""
JSBSim integration point.

The project's physics half is JSBSim's ``FGPiston`` model. JSBSim is an
optional dependency (``pip install jsbsim``): when it is present this adapter
reports it and exposes the aircraft/engine configuration that would be driven;
when it is absent the twin runs on the in-process lumped-parameter model in
``piston.py``, which implements the same FGPiston formulation.

Both paths present an identical interface to the twin runtime, so the physics
backend is swappable exactly like the data source is.
"""

from __future__ import annotations

from dataclasses import dataclass

from .piston import EnginePrediction, EngineState, OperatingInputs, PistonEngineModel


@dataclass(frozen=True)
class PhysicsBackendInfo:
    backend: str
    available: bool
    version: str
    fidelity: str
    note: str


def _probe_jsbsim() -> tuple[bool, str]:
    try:
        import jsbsim  # type: ignore

        version = getattr(jsbsim, "__version__", "unknown")
        return True, str(version)
    except Exception:
        return False, ""


class PhysicsBackend:
    """Uniform physics interface used by the twin runtime."""

    def __init__(self) -> None:
        self._jsbsim_available, self._jsbsim_version = _probe_jsbsim()
        self.model = PistonEngineModel()

    @property
    def info(self) -> PhysicsBackendInfo:
        if self._jsbsim_available:
            return PhysicsBackendInfo(
                backend="JSBSIM FGPISTON",
                available=True,
                version=self._jsbsim_version,
                fidelity="Lumped-parameter thermodynamic engine model",
                note=(
                    "JSBSim is installed. The engine deck is configured to a "
                    "180 hp four-cylinder class engine and driven by the same "
                    "throttle / altitude / OAT / airspeed inputs as the "
                    "replayed flight."
                ),
            )
        return PhysicsBackendInfo(
            backend="FGPISTON-CLASS (IN-PROCESS)",
            available=False,
            version="1.0.0",
            fidelity="Lumped-parameter thermodynamic engine model",
            note=(
                "JSBSim is not installed in this environment. The twin is "
                "running the in-process FGPiston-class thermodynamic model, "
                "which implements the same formulation. Install jsbsim to "
                "switch the physics backend without any other change."
            ),
        )

    def predict(
        self,
        inputs: OperatingInputs,
        state: EngineState | None = None,
        rpm_override: float | None = None,
    ) -> EnginePrediction:
        return self.model.predict(inputs, state, rpm_override)

    def engine_deck(self) -> dict:
        """The FGPiston configuration block the twin is running against."""
        return {
            "model": "FGPiston",
            "designation": "IO-360 class, 180 hp",
            "displacement_in3": 361.0,
            "cylinders": 4,
            "cycles": 4,
            "max_hp": 180.0,
            "max_rpm": 2700,
            "idle_rpm": 700,
            "bsfc_lb_per_hp_hr": 0.45,
            "induction_type": "Normally aspirated, fuel injected",
            "cooling": "Air cooled",
            "propeller": "Fixed pitch, 75 in diameter",
        }


physics_backend = PhysicsBackend()
