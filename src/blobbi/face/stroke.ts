/**
 * A STROKE ON THE SKIN: the 3D form of a drawn line.
 *
 * The 2D face is drawn with strokes: the mouth, the brows, the closed eye's
 * line. In 3D each of those is a flat RIBBON of constant width with round
 * caps, laid on the body's surface a hair above it, with the skin's own
 * normals. It is a drawn line from every angle: never a tube, never a flat
 * plane cutting the body, never floating at the ends, and it keeps the 2D
 * stroke weight exactly.
 *
 * The ribbon is built from a polyline in the DRAWING's coordinates (root
 * units) and a `place` function that says where a drawing point lies in
 * space; the face uses the body surface under the front drawing, an eye its
 * own dome. Topology is fixed by the sample count, so a stroke morphs by
 * updating positions only.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import { pt, type Pt } from '../geometry/math';

export interface Placed {
  position: Vector3;
  normal: Vector3;
}

/** Where a point of a drawing (root units; y as the drawing has it) lies in space, lifted `lift` root units off the surface. */
export type Placer = (x: number, y: number, lift: number) => Placed;

const CAP_STEPS = 6;

export interface Stroke {
  mesh: Mesh;
  /** The number of samples the stroke was built for; `update` takes exactly that many points. */
  samples: number;
  /** Lay the stroke along `points` (drawing coordinates), `width` wide, `lift` above the surface. */
  update(points: readonly Pt[], width: number, lift: number): void;
}

export function createStroke(scene: Scene, parent: TransformNode, name: string, material: Material, samples: number, place: Placer): Stroke {
  const edgeVerts = 2 * samples;
  const capVerts = 2 * (CAP_STEPS + 2);
  const total = edgeVerts + capVerts;
  const positions = new Float32Array(3 * total);
  const normals = new Float32Array(3 * total);
  const indices: number[] = [];
  // The ribbon: quads between consecutive samples, wound both ways so the stroke reads from either side.
  for (let i = 0; i < samples - 1; i++) {
    const a = 2 * i;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c, a, c, b, b, c, d);
  }
  // The caps: a fan from the end point over a half circle.
  for (const end of [0, 1]) {
    const base = edgeVerts + end * (CAP_STEPS + 2);
    for (let i = 0; i < CAP_STEPS; i++) {
      const p = base + 1 + i;
      const q = base + 2 + i;
      indices.push(base, p, q, base, q, p);
    }
  }
  const mesh = new Mesh(name, scene);
  mesh.parent = parent;
  mesh.material = material;
  mesh.isPickable = false;
  const data = new VertexData();
  data.positions = Array.from(positions);
  data.normals = Array.from(normals);
  data.indices = indices;
  data.applyToMesh(mesh, true);

  const set = (i: number, p: Placed) => {
    positions[3 * i] = p.position.x;
    positions[3 * i + 1] = p.position.y;
    positions[3 * i + 2] = p.position.z;
    normals[3 * i] = p.normal.x;
    normals[3 * i + 1] = p.normal.y;
    normals[3 * i + 2] = p.normal.z;
  };

  const update = (points: readonly Pt[], width: number, lift: number) => {
    if (points.length !== samples) throw new Error(`[blobbi-3d] stroke ${name}: ${samples} points expected, ${points.length} given`);
    const half = width / 2;
    // The drawing-plane direction and normal at each sample, from its neighbours.
    const dirs: Pt[] = points.map((_, i) => {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(samples - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return pt(dx / len, dy / len);
    });
    for (let i = 0; i < samples; i++) {
      const p = points[i];
      const n = pt(-dirs[i].y, dirs[i].x);
      set(2 * i, place(p.x + n.x * half, p.y + n.y * half, lift));
      set(2 * i + 1, place(p.x - n.x * half, p.y - n.y * half, lift));
    }
    for (const end of [0, 1]) {
      const base = edgeVerts + end * (CAP_STEPS + 2);
      const p = points[end === 0 ? 0 : samples - 1];
      const d = dirs[end === 0 ? 0 : samples - 1];
      // The half circle starts on one edge, swings round the outside of the end, and lands on the other edge.
      const sign = end === 0 ? -1 : 1;
      set(base, place(p.x, p.y, lift));
      for (let i = 0; i <= CAP_STEPS; i++) {
        const a = -Math.PI / 2 + (i / CAP_STEPS) * Math.PI;
        const ox = d.x * Math.cos(a) * sign - d.y * Math.sin(a);
        const oy = d.y * Math.cos(a) * sign + d.x * Math.sin(a);
        set(base + 1 + i, place(p.x + ox * half, p.y + oy * half, lift));
      }
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
    mesh.refreshBoundingInfo();
  };

  return { mesh, samples, update };
}
