/**
 * Sector terrain field.
 *
 * Lives in its own module because both the renderer and the flight model need
 * it: the renderer to build the mesh, the flight model to keep the aircraft
 * above the ground on the takeoff and approach legs.
 *
 * Scale contract. One world unit is one kilometre of sector grid, and altitude
 * is exaggerated ALT_EXAGGERATION times so a MALE UAV at 15,000 ft over a
 * 200 km sector is visible rather than a dot on a flat plane. Terrain relief
 * uses the SAME exaggeration, otherwise the aircraft flies through mountains
 * at low level - which is exactly the bug this module exists to prevent.
 */

export const ALT_EXAGGERATION = 4.0
export const FT_TO_KM = 0.0003048

export const SECTOR = { w: 220, h: 190 }

/** Where the airbase sits. Terrain is normalised so this point is at zero. */
export const BASE = { x: 18, y: 22 }

/** True relief in km before exaggeration: a ridge line plus rolling ground. */
function relief(x: number, z: number) {
  // The main ridge, plus a second lower range behind it so the horizon has
  // more than one silhouette to read against.
  const ridge = Math.exp(-((x * 0.55 + z * 0.4 - 150) ** 2) / 5200) * 2.15
  const far = Math.exp(-((x * 0.42 - z * 0.5 + 20) ** 2) / 9000) * 0.9
  // Peaks along the ridge, so it is a range rather than an embankment.
  const peaks =
    Math.exp(-((x * 0.55 + z * 0.4 - 150) ** 2) / 5200) *
    (Math.sin(x * 0.09 - z * 0.06) * 0.5 + Math.sin(x * 0.17 + z * 0.11) * 0.28) * 0.55
  const rolling =
    Math.sin(x * 0.055) * Math.cos(z * 0.047) * 0.24 +
    Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.019 - 0.7) * 0.46 +
    Math.sin(x * 0.13 + 2.1) * Math.cos(z * 0.11 - 1.4) * 0.075 +
    // Micro-relief. Small enough that nothing that flies cares about it, big
    // enough that the flat-shaded facets read as ground rather than as a wash.
    Math.sin(x * 0.29 + 1.7) * Math.cos(z * 0.33 - 0.9) * 0.03 +
    Math.sin(x * 0.62 - 0.4) * Math.cos(z * 0.57 + 2.2) * 0.014
  // A shallow basin the airfield sits in.
  const basin = -Math.exp(-((x - BASE.x) ** 2 + (z - BASE.y) ** 2) / 900) * 0.3
  return ridge + far + peaks + rolling + basin
}

const BASE_RELIEF = relief(BASE.x, BASE.y)

/**
 * Terrain height in world units, normalised so the airbase is at exactly 0.
 * Without that normalisation the runway sits at some arbitrary altitude and
 * the aircraft spawns underground.
 */
export function terrainHeight(x: number, z: number) {
  return (relief(x, z) - BASE_RELIEF) * ALT_EXAGGERATION
}

/** Peak relief along the route, for camera and cloud placement. */
export const TERRAIN_MAX = 11.5
