/**
 * THE ARENA'S SHAPE, as pure geometry: three zones over a void. A wide,
 * safe centre where the fights are meant to happen, and a narrower wing on
 * each side, closer to the rim, where the risk is. The right wing is the
 * sweeper's. Everything else that needs to know where the floor is (orbs,
 * spawns, the sweeper, tests) asks this; the scene only draws it.
 *
 *   top view (x right, z up), metres:
 *
 *            ┌──────────────┐
 *     ┌──────┤              ├──────┐
 *     │ left │    centre    │ right│ ◄── sweeper pivot in the right wing
 *     └──────┤              ├──────┘
 *            └──────────────┘
 */
export interface Rect {
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
}

export interface Planar {
  x: number;
  z: number;
}

export const ARENA = Object.freeze({
  centre: { x: 0, z: 0, halfWidth: 4, halfDepth: 4 } as Rect,
  wings: { halfWidth: 1.75, halfDepth: 3.0 },
  /** The floor's thickness below y = 0, metres. */
  thickness: 0.6,
  /**
   * Where the fighters start each round, by how many play: in the centre
   * slab, apart, at least 1.5 m from every rim, clear of the orbs and the
   * sweeper, and each as far from the middle orb as the others. Four stand
   * at the corners of a square around it; three on a triangle; two face
   * each other across it.
   */
  spawnSets: {
    2: [
      { x: -2.2, z: 0 },
      { x: 2.2, z: 0 },
    ],
    3: [
      { x: 0, z: -2.45 },
      { x: 2.12, z: 1.225 },
      { x: -2.12, z: 1.225 },
    ],
    4: [
      { x: -2.2, z: -2.2 },
      { x: 2.2, z: -2.2 },
      { x: -2.2, z: 2.2 },
      { x: 2.2, z: 2.2 },
    ],
  } as Record<2 | 3 | 4, readonly Planar[]>,
});

export type FighterCount = 2 | 3 | 4;

/** The spawns for this many fighters, each facing the middle of the arena (a yaw: the direction (sin a, cos a)). */
export function spawnPoints(count: FighterCount, a = ARENA): { x: number; z: number; yaw: number }[] {
  return a.spawnSets[count].map((p) => ({ x: p.x, z: p.z, yaw: Math.atan2(-p.x, -p.z) }));
}

/** The three floor slabs: centre, left wing, right wing. */
export function floorSlabs(a = ARENA): Rect[] {
  const wingX = a.centre.halfWidth + a.wings.halfWidth;
  return [a.centre, { x: -wingX, z: 0, halfWidth: a.wings.halfWidth, halfDepth: a.wings.halfDepth }, { x: wingX, z: 0, halfWidth: a.wings.halfWidth, halfDepth: a.wings.halfDepth }];
}

/** The whole floor's extent, metres. */
export function arenaExtent(a = ARENA): { halfWidth: number; halfDepth: number } {
  return { halfWidth: a.centre.halfWidth + 2 * a.wings.halfWidth, halfDepth: Math.max(a.centre.halfDepth, a.wings.halfDepth) };
}

const inRect = (r: Rect, p: Planar, inset: number) => Math.abs(p.x - r.x) <= r.halfWidth - inset && Math.abs(p.z - r.z) <= r.halfDepth - inset;

/**
 * Whether a point is on the floor, at least `inset` from the void. The
 * floor is the UNION of the slabs: a positive inset is measured to the
 * outer rim (`rimDistance`), never to the seam where a wing meets the
 * centre, which is floor on both sides. A negative inset (a footprint)
 * widens each slab.
 */
export function onFloor(p: Planar, inset = 0, a = ARENA): boolean {
  const slabs = floorSlabs(a);
  if (inset <= 0) return slabs.some((r) => inRect(r, p, inset));
  return slabs.some((r) => inRect(r, p, 0)) && rimDistance(p, a) >= inset;
}

const segmentDistance = (p: Planar, [a, b]: [Planar, Planar]) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

const rimCache = new WeakMap<object, [Planar, Planar][]>();
const rimOf = (a: typeof ARENA) => {
  let r = rimCache.get(a);
  if (!r) rimCache.set(a, (r = rimSegments(a)));
  return r;
};

/**
 * How far a point on the floor is from the void (0 off the floor), exactly:
 * the distance to the nearest outer rim segment. Before M7D this grew an
 * inset per slab, which measured the seams between the centre and the
 * wings as rims and made the crossing look like a cliff edge.
 */
export function rimDistance(p: Planar, a = ARENA): number {
  if (!floorSlabs(a).some((r) => inRect(r, p, 0))) return 0;
  let d = Infinity;
  for (const seg of rimOf(a)) d = Math.min(d, segmentDistance(p, seg));
  return d;
}

/** The outer rim as segments (from, to), for drawing: every slab edge not shared with another slab. */
export function rimSegments(a = ARENA): [Planar, Planar][] {
  const out: [Planar, Planar][] = [];
  const slabs = floorSlabs(a);
  const isInside = (p: Planar) => onFloor(p, -1e-6, a);
  for (const r of slabs) {
    const corners = [
      { x: r.x - r.halfWidth, z: r.z - r.halfDepth },
      { x: r.x + r.halfWidth, z: r.z - r.halfDepth },
      { x: r.x + r.halfWidth, z: r.z + r.halfDepth },
      { x: r.x - r.halfWidth, z: r.z + r.halfDepth },
    ];
    for (let i = 0; i < 4; i++) {
      const from = corners[i];
      const to = corners[(i + 1) % 4];
      // Walk the edge in small steps, keeping the runs whose outward side is void.
      const n = 64;
      const dx = (to.x - from.x) / n;
      const dz = (to.z - from.z) / n;
      const ox = r.x - (from.x + to.x) / 2;
      const oz = r.z - (from.z + to.z) / 2;
      const len = Math.hypot(ox, oz) || 1;
      const outward = { x: (-ox / len) * 0.02, z: (-oz / len) * 0.02 };
      let runStart: Planar | null = null;
      for (let k = 0; k <= n; k++) {
        const mid = { x: from.x + dx * (k + 0.5), z: from.z + dz * (k + 0.5) };
        const exposed = k < n && !isInside({ x: mid.x + outward.x, z: mid.z + outward.z });
        if (exposed && runStart === null) runStart = { x: from.x + dx * k, z: from.z + dz * k };
        if (!exposed && runStart !== null) {
          out.push([runStart, { x: from.x + dx * k, z: from.z + dz * k }]);
          runStart = null;
        }
      }
    }
  }
  return out;
}
