/**
 * Runtime capability probes.
 *
 * The cinematic layer is an enhancement, never a requirement: if the machine
 * cannot give us WebGL, or the operator has asked for reduced motion, the
 * product still has to render every number. These are the checks the visual
 * layer branches on.
 */

let webglCache: boolean | null = null

export function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    webglCache = !!gl
    // Release the probe context immediately - browsers cap the number of live
    // contexts and the real stages need them.
    const lose = (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')
    lose?.loseContext()
  } catch {
    webglCache = false
  }
  return webglCache
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** A coarse device budget, used to scale particle and cloud counts. */
export function performanceTier(): 'LOW' | 'MID' | 'HIGH' {
  try {
    const cores = navigator.hardwareConcurrency ?? 4
    const mobile = window.matchMedia('(pointer: coarse)').matches
    const small = window.innerWidth < 1100
    if (mobile || small || cores <= 4) return 'LOW'
    if (cores <= 8) return 'MID'
    return 'HIGH'
  } catch {
    return 'MID'
  }
}
