/**
 * THE SKIN PAINTER: everything that lies flat on the body, painted into one
 * texture wrapped round it.
 *
 *  - the body's own tone: a soft vertical gradient (lit crown, deeper
 *    base) and the authored shine high on the viewer's left;
 *  - the PATTERN (spots on the flanks and back, bands across the back, a
 *    gradient deepening toward the base), in the secondary colour;
 *  - the belly patch, the special mark, the freckles;
 *  - the cheeks and their blush, which an expression deepens.
 *
 * Positions come from the morphology in the kit's own terms (degrees round
 * the body, fractions of its height, root units) and `BodySurface.uvOf`
 * puts them on the texture, so a spot that sits on the rear of the left
 * flank in the drawing sits on the rear of the left flank in 3D.
 *
 * The painter is pure canvas 2D; it has no Babylon dependency, so it can be
 * tested and reused by any renderer with a canvas.
 */
import type { BodySurface } from '../geometry/body';
import { lerp, rad, TAU } from '../geometry/math';
import { CHEEKS, SHINE, TOP } from '../geometry/plan';
import { mixOklab, rgbOf } from '../identity/colors';
import { blushOpacity, type FacePose } from '../face/expressions';
import type { BlobbiMorphology, MarkMorphology, SpecialMarkMorphology } from '../morphology/morphology';

export interface PaintOptions {
  /** How much of the kit's painted gradient to keep; lighting does the rest. 0..1. */
  gradientStrength?: number;
  /** Draw the authored shine ellipse. */
  shine?: boolean;
}

export interface SkinState {
  pose: FacePose;
  sleeping: boolean;
}

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
};

/** Pixel radii for a root-unit ellipse at a height fraction from the base. */
function pixelRadii(surface: BodySurface, v: number, rx: number, ry: number, W: number, H: number) {
  const { unitsPerU, unitsPerV } = surface.uvScaleAt(v);
  return { prx: (rx / unitsPerU) * W, pry: (ry / unitsPerV) * H };
}

/** Draw a shape at a texture u (0..1) and again shifted by ±1 so it wraps across the seam. */
function wrapped(W: number, px: number, draw: (x: number) => void) {
  draw(px);
  if (px < W * 0.35) draw(px + W);
  if (px > W * 0.65) draw(px - W);
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rotationDeg: number, fill: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rad(rotationDeg));
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

function markPath(ctx: CanvasRenderingContext2D, kind: SpecialMarkMorphology['kind'], r: number) {
  ctx.beginPath();
  if (kind === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.48;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
  } else if (kind === 'heart') {
    ctx.moveTo(0, r * 0.95);
    ctx.bezierCurveTo(-r * 1.25, r * 0.05, -r * 0.95, -r * 1.05, 0, -r * 0.4);
    ctx.bezierCurveTo(r * 0.95, -r * 1.05, r * 1.25, r * 0.05, 0, r * 0.95);
    ctx.closePath();
  } else if (kind === 'sparkle') {
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 4;
      const rr = i % 2 === 0 ? r : r * 0.22;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
  } else {
    // A crescent: the outer circle, then back along an offset circle.
    const n = 24;
    const off = r * 0.5;
    const r2 = r * 0.86;
    const a0 = -Math.PI * 0.62;
    const a1 = Math.PI * 0.62;
    for (let i = 0; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    for (let i = n; i >= 0; i--) {
      const a = lerp(a0 * 0.95, a1 * 0.95, i / n);
      ctx.lineTo(off + Math.cos(a) * r2, Math.sin(a) * r2);
    }
    ctx.closePath();
  }
}

/** Paint the whole skin. `ctx` is a canvas of `W` by `H`; the crown is at the top row and the face at the middle column. */
export function paintSkin(ctx: CanvasRenderingContext2D, W: number, H: number, surface: BodySurface, m: BlobbiMorphology, state: SkinState, options: PaintOptions = {}) {
  const p = m.palette;
  const gradientStrength = options.gradientStrength ?? 0.55;
  const py = (v: number) => (1 - v) * H;
  const px = (u: number) => u * W;

  // The body's tone: lit crown, deeper base.
  const light = mixOklab(p.bodyMid, p.bodyLight, 0.75 * gradientStrength);
  const dark = mixOklab(p.bodyMid, p.bodyDark, 0.8 * gradientStrength);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, light);
  grad.addColorStop(0.42, p.bodyMid);
  grad.addColorStop(1, dark);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // The pattern.
  if (m.pattern === 'gradient' && m.gradient) {
    const g = ctx.createLinearGradient(0, py(1 - m.gradient.start), 0, H);
    g.addColorStop(0, rgba(p.marking, 0));
    g.addColorStop(1, rgba(p.marking, m.gradient.strength));
    ctx.fillStyle = g;
    ctx.fillRect(0, py(1 - m.gradient.start), W, H);
  }
  if (m.pattern === 'striped' && m.stripes) {
    for (const band of m.stripes.bands) {
      const v = 1 - band.yFraction;
      const { pry } = pixelRadii(surface, v, 1, band.thickness / 2, W, H);
      const reachU = band.reach / 360;
      const steps = 40;
      const draw = (cx: number) => {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = -1 + (2 * i) / steps;
          const taper = Math.sqrt(Math.max(0, 1 - t * t));
          ctx.lineTo(cx + t * reachU * W, py(v) - pry * taper);
        }
        for (let i = steps; i >= 0; i--) {
          const t = -1 + (2 * i) / steps;
          const taper = Math.sqrt(Math.max(0, 1 - t * t));
          ctx.lineTo(cx + t * reachU * W, py(v) + pry * taper);
        }
        ctx.closePath();
        ctx.fillStyle = rgba(p.marking, 0.85);
        ctx.fill();
      };
      // The bands are centred on the back: the seam.
      draw(0);
      draw(W);
    }
  }
  if (m.pattern === 'spotted') {
    for (const spot of m.spots) paintSpot(ctx, W, H, surface, spot, rgba(p.marking, 0.9));
  }

  // The belly patch: a lighter oval low on the front.
  if (m.bellyPatch) {
    const b = m.bellyPatch;
    const v = 1 - b.yFraction;
    const { prx, pry } = pixelRadii(surface, v, b.rx, b.ry, W, H);
    ellipse(ctx, px(0.5), py(v), prx, pry, 0, rgba(p.belly, b.opacity));
  }

  // The special mark.
  if (m.mark) {
    const k = m.mark;
    const { u, v } = surface.uvOf(k.theta, k.side, k.yFraction);
    const { prx, pry } = pixelRadii(surface, v, k.r, k.r, W, H);
    wrapped(W, px(u), (x) => {
      ctx.save();
      ctx.translate(x, py(v));
      ctx.rotate(rad(k.rotation));
      ctx.scale(prx, pry);
      markPath(ctx, k.kind, 1);
      ctx.fillStyle = p.mark;
      ctx.fill();
      ctx.restore();
    });
  }

  // The shine: the authored highlight, high on the viewer's left.
  if (options.shine !== false) {
    const sx = SHINE.dx * m.bodyWidth * lerp(1, m.topWidth, 0.5);
    const sy = surface.front.top + (SHINE.dy / 630.66717) * surface.front.height;
    const { u, v } = surface.uvOfFront(sx, sy);
    const { prx, pry } = pixelRadii(surface, v, SHINE.rx, SHINE.ry, W, H);
    ellipse(ctx, px(u), py(v), prx * 1.1, pry * 1.1, SHINE.rotation, 'rgba(255,255,255,0.42)');
  }

  // The cheeks and the blush, under the outer corners of the eyes.
  const blush = blushOpacity(state.pose.blush, CHEEKS.opacity, CHEEKS.highlightOpacity);
  const cheekSpacing = ((CHEEKS.right.x - CHEEKS.left.x) / 2) * lerp(1, m.bodyWidth, 0.8) * lerp(1, m.eyeSpacing, 0.5);
  const cheekY = surface.front.top + ((CHEEKS.left.y - TOP) / 630.66717) * surface.front.height;
  const flush = 1;
  for (const side of [-1, 1] as const) {
    const cx = side * cheekSpacing;
    const { u, v } = surface.uvOfFront(cx, cheekY);
    const { prx, pry } = pixelRadii(surface, v, CHEEKS.rx * m.cheekSize * flush, CHEEKS.ry * m.cheekSize * flush, W, H);
    if (blush.base > 0) ellipse(ctx, px(u), py(v), prx, pry, 0, rgba(p.cheek, blush.base));
    if (blush.highlight > 0) {
      const h = CHEEKS.highlight;
      const hu = surface.uvOfFront(cx + h.dx * m.cheekSize * (side === -1 ? 1 : -1) * -1, cheekY + h.dy * m.cheekSize);
      const hr = pixelRadii(surface, v, h.rx * m.cheekSize, h.ry * m.cheekSize, W, H);
      ellipse(ctx, px(hu.u), py(hu.v), hr.prx, hr.pry, 0, rgba('#ffffff', blush.highlight));
    }
    // Freckles ride the cheek: `dx` is toward the outside of the face.
    for (const f of m.freckles) {
      const fu = surface.uvOfFront(cx + side * f.dx, cheekY + f.dy);
      const fr = pixelRadii(surface, v, f.r, f.r, W, H);
      ellipse(ctx, px(fu.u), py(fu.v), fr.prx, fr.pry, 0, rgba(p.line, 0.55));
    }
  }
}

function paintSpot(ctx: CanvasRenderingContext2D, W: number, H: number, surface: BodySurface, spot: MarkMorphology, fill: string) {
  const yFraction = spot.yFraction + spot.dy / surface.front.height;
  const { u, v } = surface.uvOf(spot.theta, spot.side, yFraction);
  const { prx, pry } = pixelRadii(surface, v, spot.rx, spot.ry, W, H);
  wrapped(W, u * W, (x) => ellipse(ctx, x, (1 - v) * H, prx, pry, spot.rotation * spot.side, fill));
}

