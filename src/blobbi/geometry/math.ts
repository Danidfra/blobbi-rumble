/** Small 2D helpers shared by the silhouette and the painters. */
export interface Pt {
  x: number;
  y: number;
}
export const pt = (x: number, y: number): Pt => ({ x, y });
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const smoothstep = (u: number) => {
  const t = clamp01(u);
  return t * t * (3 - 2 * t);
};
export const rad = (deg: number) => (deg * Math.PI) / 180;
export const TAU = Math.PI * 2;

export interface Cubic {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p1: Pt;
}

export function cubicAt(s: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return pt(a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x, a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y);
}

export function sampleCubic(s: Cubic, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => cubicAt(s, i / n));
}

export function quadraticAt(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return pt(u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, u * u * p0.y + 2 * u * t * c.y + t * t * p1.y);
}
