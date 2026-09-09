"""
Aero piston engine thermodynamic model - JSBSim ``FGPiston`` class.

This is the physics half of the twin. It is driven by the *same inputs* as the
real engine (throttle, mixture, pressure altitude, outside air temperature and
indicated airspeed) and forward-solves the operating point and thermal state.
Nothing downstream ever reads a sensor value to produce an expectation.

Fidelity statement (repeated in the product UI):
    This is a lumped-parameter thermodynamic model of the same family as
    JSBSim's FGPiston. It is NOT a crank-angle-resolved CFD simulation.
    Where its predictions diverge from the real data distribution, that
    divergence is reported on the Validation page rather than hidden.

Model chain
    throttle + altitude          -> manifold absolute pressure
    MAP + RPM + volumetric eff.  -> induction air mass flow
    air flow + equivalence ratio -> fuel flow, indicated power
    indicated power - friction   -> brake power
    brake power == propeller absorbed power  -> RPM (implicit, solved)
    combustion + mixture         -> per-cylinder EGT
    heat rejection / cooling air -> per-cylinder CHT
    CHT + power                  -> oil temperature -> oil pressure
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

from ..core import atmosphere as atm
from ..core.constants import CYLINDER_COOLING_BIAS, CYLINDER_EGT_BIAS, ENGINE

# --- calibration constants -------------------------------------------------
# Calibrated so the model reproduces the rated point of a 180 hp / 2700 rpm
# four-cylinder engine and a representative 65-75% cruise thermal state.

K_INDICATED_HP = 2.551e-3       # hp per (rpm * inHg) at unity volumetric eff.
K_AIRFLOW_LB_HR = 1.427e-2      # lb/hr induction air per (rpm * inHg)
K_CHT = 233.0                   # degC head rise at unity cooling conductance
K_EGT_BASE = 600.0
K_EGT_POWER = 190.0
PROP_DIAMETER_M = 1.905
PROP_CP0 = 0.0500
SLIPSTREAM_KT = 40.0
COOLING_REF_KT = 150.0
STOICH_AFR = 14.7


@dataclass(slots=True)
class EngineState:
    """Slow-moving engine parameters tracked online by the state estimator.

    These are what turn a generic simulation into a twin *of this engine*.
    """

    volumetric_efficiency: float = 1.0
    cooling_effectiveness: float = 1.0
    # Multiplicative deviation of each cylinder's heat rejection (0.0 = nominal)
    cylinder_trim: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0, 0.0])
    # Additive deviation of each cylinder's exhaust temperature, degC
    cylinder_egt_trim: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0, 0.0])

    def copy(self) -> "EngineState":
        return replace(
            self,
            cylinder_trim=list(self.cylinder_trim),
            cylinder_egt_trim=list(self.cylinder_egt_trim),
        )

    def as_dict(self) -> dict:
        return {
            "volumetric_efficiency": self.volumetric_efficiency,
            "cooling_effectiveness": self.cooling_effectiveness,
            "cylinder_trim": list(self.cylinder_trim),
            "cylinder_egt_trim": list(self.cylinder_egt_trim),
        }


@dataclass(slots=True)
class OperatingInputs:
    """The control and ambient inputs shared by the real engine and the twin."""

    throttle: float          # 0..1
    mixture: float           # 0..1  (1.0 = full rich)
    altitude_ft: float
    oat_c: float
    ias_kt: float


@dataclass(slots=True)
class EnginePrediction:
    rpm: float
    map_inhg: float
    power_hp: float
    power_fraction: float
    fuel_flow_gph: float
    air_flow_lb_hr: float
    equivalence_ratio: float
    egt_c: list[float]
    cht_c: list[float]
    oil_temp_c: float
    oil_press_psi: float
    vibration_g: float
    inj_timing_deg: float
    density_ratio: float
    tas_kt: float

    def channel_map(self) -> dict[str, float]:
        return {
            "rpm": self.rpm,
            "map_inhg": self.map_inhg,
            "fuel_flow_gph": self.fuel_flow_gph,
            "egt_1": self.egt_c[0], "egt_2": self.egt_c[1],
            "egt_3": self.egt_c[2], "egt_4": self.egt_c[3],
            "cht_1": self.cht_c[0], "cht_2": self.cht_c[1],
            "cht_3": self.cht_c[2], "cht_4": self.cht_c[3],
            "oil_press_psi": self.oil_press_psi,
            "oil_temp_c": self.oil_temp_c,
            "vibration_g": self.vibration_g,
            "inj_timing_deg": self.inj_timing_deg,
        }


def equivalence_ratio(mixture: float) -> float:
    """Map the mixture lever (0=lean cutoff region, 1=full rich) to phi."""
    return 0.78 + 0.52 * max(0.0, min(1.0, mixture))


def _combustion_efficiency(phi: float) -> float:
    """Relative indicated efficiency; peaks slightly rich of stoichiometric."""
    return max(0.55, 1.0 - 0.85 * (phi - 1.08) ** 2)


def _friction_hp(rpm: float) -> float:
    return 3.0 + 0.0055 * rpm * (rpm / ENGINE["rated_rpm"])


def manifold_pressure(throttle: float, altitude_ft: float, rpm: float) -> float:
    """Throttle plate + induction loss model."""
    p_amb = atm.pressure_inhg(altitude_ft)
    plate = 0.13 + 0.87 * max(0.0, min(1.0, throttle))
    induction_loss = 1.2 * (rpm / ENGINE["rated_rpm"]) ** 2 * throttle
    return max(6.0, p_amb * plate - induction_loss)


def _indicated_hp(rpm: float, map_inhg: float, ve: float, phi: float, oat_c: float) -> float:
    charge_density_corr = math.sqrt(T_REF_K / max(220.0, oat_c + 273.15 + 28.0))
    return (
        K_INDICATED_HP * ve * map_inhg * rpm
        * _combustion_efficiency(phi) * charge_density_corr
    )


T_REF_K = 288.15 + 28.0


def _propeller_absorbed_hp(rpm: float, tas_kt: float, sigma: float) -> float:
    """Fixed-pitch propeller power absorption, P = Cp * rho * n^3 * D^5."""
    n = max(1.0, rpm) / 60.0
    v_ms = tas_kt * 0.514444
    advance_ratio = v_ms / (n * PROP_DIAMETER_M)
    cp = PROP_CP0 * max(0.35, 1.0 - 0.34 * (advance_ratio - 0.62))
    watts = cp * (1.225 * sigma) * n ** 3 * PROP_DIAMETER_M ** 5
    return watts / 745.7


class PistonEngineModel:
    """Forward thermodynamic model of the 180 hp four-cylinder class engine."""

    name = "FGPISTON-180"
    fidelity = "Lumped-parameter thermodynamic (JSBSim FGPiston class)"

    def __init__(self, cylinders: int = 4) -> None:
        self.cylinders = cylinders

    # -- operating point ----------------------------------------------------

    def solve_rpm(self, inputs: OperatingInputs, state: EngineState) -> float:
        """Balance engine brake power against propeller absorbed power.

        Fixed-pitch propeller: shaft speed is not commanded, it is the
        equilibrium of two power curves. Solved by bisection - the residual
        function is monotonic in RPM over the physical range.
        """
        sigma = atm.density_ratio(inputs.altitude_ft, inputs.oat_c)
        tas = atm.tas_kt(inputs.ias_kt, inputs.altitude_ft, inputs.oat_c)
        phi = equivalence_ratio(inputs.mixture)

        def imbalance(rpm: float) -> float:
            mp = manifold_pressure(inputs.throttle, inputs.altitude_ft, rpm)
            brake = _indicated_hp(rpm, mp, state.volumetric_efficiency, phi, inputs.oat_c)
            brake -= _friction_hp(rpm)
            return brake - _propeller_absorbed_hp(rpm, tas, sigma)

        lo, hi = 500.0, 3000.0
        if imbalance(lo) < 0:
            return lo
        if imbalance(hi) > 0:
            return hi
        for _ in range(34):
            mid = 0.5 * (lo + hi)
            if imbalance(mid) > 0:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    # -- full prediction ----------------------------------------------------

    def predict(
        self,
        inputs: OperatingInputs,
        state: EngineState | None = None,
        rpm_override: float | None = None,
    ) -> EnginePrediction:
        st = state or EngineState()
        sigma = atm.density_ratio(inputs.altitude_ft, inputs.oat_c)
        tas = atm.tas_kt(inputs.ias_kt, inputs.altitude_ft, inputs.oat_c)
        phi = equivalence_ratio(inputs.mixture)

        rpm = rpm_override if rpm_override is not None else self.solve_rpm(inputs, st)
        mp = manifold_pressure(inputs.throttle, inputs.altitude_ft, rpm)

        indicated = _indicated_hp(rpm, mp, st.volumetric_efficiency, phi, inputs.oat_c)
        brake = max(0.0, indicated - _friction_hp(rpm))
        power_fraction = brake / ENGINE["rated_power_hp"]

        air_lb_hr = (
            K_AIRFLOW_LB_HR * st.volumetric_efficiency * mp * rpm
            * math.sqrt(T_REF_K / max(220.0, inputs.oat_c + 273.15 + 28.0))
        )
        fuel_lb_hr = air_lb_hr * phi / STOICH_AFR
        fuel_gph = fuel_lb_hr / 6.0

        # --- combustion / exhaust temperature ------------------------------
        egt_base = (
            K_EGT_BASE
            + K_EGT_POWER * min(1.25, power_fraction)
            - 900.0 * (phi - 1.0) ** 2
            + 0.55 * (inputs.oat_c - 15.0)
        )
        egt = [
            egt_base + CYLINDER_EGT_BIAS[i] + st.cylinder_egt_trim[i]
            for i in range(self.cylinders)
        ]

        # --- cooling / cylinder head temperature ---------------------------
        v_eff = tas + SLIPSTREAM_KT
        cooling_conductance = (
            max(0.15, st.cooling_effectiveness)
            * sigma ** 0.62
            * (v_eff / COOLING_REF_KT) ** 0.58
        )
        heat_index = max(0.0, min(1.35, power_fraction)) ** 0.5
        mixture_charge_cooling = 1.0 - 0.35 * max(0.0, phi - 1.0)
        head_rise = K_CHT * heat_index * mixture_charge_cooling / cooling_conductance
        cht = [
            inputs.oat_c
            + head_rise * (1.0 + st.cylinder_trim[i])
            + CYLINDER_COOLING_BIAS[i]
            for i in range(self.cylinders)
        ]

        # --- lubrication ---------------------------------------------------
        cht_mean = sum(cht) / len(cht)
        oil_raw = (
            inputs.oat_c + 55.0 + 0.22 * (cht_mean - 180.0) + 42.0 * power_fraction
        )
        oil_temp = 82.0 + 0.55 * (oil_raw - 78.0)   # oil cooler bypass thermostat
        oil_temp = max(40.0, min(122.0, oil_temp))
        oil_press = 15.0 + 0.0245 * rpm - 0.28 * (oil_temp - 80.0)
        oil_press = max(0.0, min(110.0, oil_press))

        # --- SIMULATED channels (no real counterpart in the corpus) --------
        spread = _spread(cht)
        vibration = (
            0.28 + 9.0e-5 * rpm + 0.16 * power_fraction + 0.010 * spread
        )
        inj_timing = 20.0 + 6.0 * (1.0 - min(1.0, power_fraction)) + 0.0012 * (rpm - 2000.0)

        return EnginePrediction(
            rpm=rpm,
            map_inhg=mp,
            power_hp=brake,
            power_fraction=power_fraction,
            fuel_flow_gph=fuel_gph,
            air_flow_lb_hr=air_lb_hr,
            equivalence_ratio=phi,
            egt_c=egt,
            cht_c=cht,
            oil_temp_c=oil_temp,
            oil_press_psi=oil_press,
            vibration_g=vibration,
            inj_timing_deg=inj_timing,
            density_ratio=sigma,
            tas_kt=tas,
        )


def _spread(values: list[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return max(abs(v - mean) for v in values)
