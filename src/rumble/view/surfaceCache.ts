/**
 * L4.6-FIX1: A BLOBBI'S FACE SURFACE, CACHED. The kit lays the eyes, lids,
 * brows and mouth onto the body by asking its surface where a front-view
 * point lies on the skin (`frontPoint`, and `uvOfFront` for the lids'
 * skin). Each answer scans the body's outline about eleven times, and a
 * blink or a change of expression asks well over a thousand of them per
 * eye per frame: 15-30 ms for one Blobbi, so a few blinking at once froze
 * the page for 100-300 ms. The surface never changes after it is built,
 * so its answers are sampled once, lazily, on a fine lattice over the
 * front view, and read back by bilinear interpolation: the same points to
 * within micrometres, in a fraction of the time.
 *
 * Exact where it matters: `frontPoint` is the skin point plus the normal
 * times `offset`, so the lattice keeps the skin point and normal (offset
 * applied after, exactly), and the normal is renormalised. Bounded: at
 * most `maxNodes` lattice points are kept per surface (the face uses far
 * fewer); past that, the lattice starts over. Nothing else of the surface
 * is touched.
 */
import type { Blobbi3D, BodySurface } from '@blobbi-kit/3d';
import { NEUTRAL_POSE } from '@blobbi-kit/renderer/procedural';

export const SURFACE_CACHE = Object.freeze({
  /**
   * The lattice step, in the kit's front-view (root) units (a face spans about 320 of them). Measured on several
   * Blobbis over a blink and every expression: at most 0.042 mm from the exact point and 0.23° from its normal (the skin
   * texture's texel is about 2.5 mm), ~9,000 lattice points, and a face's update ~17× cheaper (8.5 → 0.5 ms).
   */
  step: 2,
  maxNodes: 16_384,
});

type Point = ReturnType<BodySurface['frontPoint']>;
type Uv = ReturnType<BodySurface['uvOfFront']>;

/** Replace `surface.frontPoint` and `surface.uvOfFront` with lattice-cached versions (in place: the face holds this object). */
export function cacheFaceSurface(surface: BodySurface, step: number = SURFACE_CACHE.step, maxNodes: number = SURFACE_CACHE.maxNodes) {
  const exactPoint = surface.frontPoint.bind(surface);
  const exactUv = surface.uvOfFront.bind(surface);
  /** Per lattice point (keyed by its indices, packed in one number): x, y, z, nx, ny, nz (the skin point and its normal), u, v. */
  const nodes = new Map<number, Float32Array>();
  const stats = { nodes: 0, resets: 0, queries: 0 };
  const node = (i: number, j: number): Float32Array => {
    const key = (i + 32768) * 65536 + (j + 32768);
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size >= maxNodes) {
      nodes.clear();
      cell = null;
      stats.resets += 1;
    }
    const p = exactPoint(i * step, j * step, 0);
    const uv = exactUv(i * step, j * step);
    n = Float32Array.of(p.x, p.y, p.z, p.nx, p.ny, p.nz, uv.u, uv.v);
    nodes.set(key, n);
    stats.nodes = nodes.size;
    return n;
  };
  const out = new Float64Array(8);
  let ci = 0;
  let cj = 0;
  let cell: Float32Array[] | null = null;
  /** Bilinear blend of the four lattice points around (viewerX, rootY), into `out`. */
  const sample = (viewerX: number, rootY: number) => {
    stats.queries += 1;
    const fx = viewerX / step;
    const fy = rootY / step;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    // Consecutive queries mostly fall in the same cell: its four corners are kept at hand.
    if (i !== ci || j !== cj || !cell) {
      ci = i;
      cj = j;
      cell = [node(i, j), node(i + 1, j), node(i, j + 1), node(i + 1, j + 1)];
    }
    const [a, b, c, d] = cell;
    for (let k = 0; k < 8; k++) out[k] = (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty;
  };
  surface.frontPoint = (viewerX: number, rootY: number, offset = 0): Point => {
    sample(viewerX, rootY);
    const len = Math.hypot(out[3], out[4], out[5]) || 1;
    const nx = out[3] / len;
    const ny = out[4] / len;
    const nz = out[5] / len;
    return { x: out[0] + nx * offset, y: out[1] + ny * offset, z: out[2] + nz * offset, nx, ny, nz } as Point;
  };
  surface.uvOfFront = (viewerX: number, rootY: number): Uv => {
    sample(viewerX, rootY);
    return { u: out[6], v: out[7] } as Uv;
  };
  return { stats, exactPoint, exactUv };
}

/**
 * Sample the lattice where a blink will need it, now (while the fighter
 * is being built, already the costly moment), so a Blobbi's first blink in
 * play costs what every later one does. The face is left as it was found
 * (neutral, eyes open); its next update applies the real pose.
 */
export function warmBlink(blobbi: Pick<Blobbi3D, 'face'>) {
  const gaze = { x: 0, y: 0 };
  for (let k = 1; k <= 10; k++) blobbi.face.apply(NEUTRAL_POSE, gaze, false, k / 10);
  blobbi.face.apply(NEUTRAL_POSE, gaze, false, 0);
}

