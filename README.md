# blobbi-3d

A procedural 3D Blobbi for the browser: the same seed-derived identity as the
2D procedural Blobbi (blobbi-kit, visual generation V3, algorithm 1), rendered
as a reusable Babylon.js game character.

```
blobbi-kit identity / genome  ──►  @blobbi-kit/renderer   (2D, SVG)
blobbi-kit identity / genome  ──►  blobbi-3d              (3D, Babylon.js)   ← this
```

The question this repository answers: **can a procedural 3D Blobbi be
recognisably the same character as the 2D one, with an architecture that is
reusable for party games, farming games and social spaces?** Open the
playground and judge.

## Run it

```
npm install
npm run dev          # http://127.0.0.1:5177/
npm run check        # typecheck, tests, build
```

Playground: WASD / arrows to walk, Shift to run, Space to jump; drag to orbit,
wheel to zoom. The panel picks a seed (the canonical Blobbi, the 2D lab's named
seeds, real nostr-pet dev seeds, or any pasted 64-digit seed), an expression,
sleeping, a pinned motion state, and a lineup of eight presets to compare.

## What was inspected, and what it means for 3D

Repositories read (none modified): `blobbi-kit` (`packages/blobbi-core/src/blobbi-v3-identity.ts`,
`packages/blobbi-renderer/src/procedural/*`, `artwork/v3/*`), `blobbi-procedural` (the
V3 lab) and `nostr-pet` (consumer; dev seeds).

| Concept | In blobbi-kit | Here |
| --- | --- | --- |
| **Seed** | `sha256("blobbi:v1\|pubkey:d:created_at")`, 64 lower-case hex digits; the ONLY input the algorithm is defined over (`canonicalBlobbiV3Seed`). | `identity/seed.ts`: same canonical form; `seedFromLabel` reproduces the lab's label→seed rule so `pattern-0` is the same individual in both. |
| **RNG** | cyrb128 + sfc32, 12 warm-up draws; one KEYED stream per gene (`geneRng(seed, 'morphology.bodyWidth')`), `centered()` = mean of two uniforms. | `identity/rng.ts`: bit-for-bit port, pinned by fixtures the kit itself produced. |
| **Identity** | Two layers: EXPLICIT (colours, trait kinds, pattern, mark, belly, freckles) decided once by the seed at creation and then stored on the kind 31124 event; DERIVED micro-geometry re-derived from the seed under a frozen `visual_algorithm`. A stated field always wins. | `identity/identity.ts`: same shape as core's `BlobbiV3Identity`; `createBlobbiIdentity(seed)`, `resolveBlobbiIdentity(partial)` with `inferred[]`. A host passes the parsed event identity straight in. |
| **Genome** | 24 morphology genes in [-1, 1] (0 = canonical), trait genes always generated even when a trait is off, crown-crowding rules (horns displace ears; top horns move to the side when an antenna stands there). | `identity/genome.ts`: faithful port (egg genes left out). |
| **Colours** | OKLCH generator with per-hue lightness and chroma guardrails; `derivePalette` turns four trait colours into every painting role via offsets measured from the authored purple. | `identity/colors.ts`: port; the palette feeds the materials and the skin painter. |
| **Morphology** | genes → `base ± spread` in root units (the Adult V2 artwork's unit), small spreads: one species, many individuals. | `morphology/morphology.ts`: adult port, number for number (tested against the kit). |
| **Antenna** | `none/single/double`; side, crown position, fore/aft set, length, thickness, curvature, tilt, sweep, tip size, pair asymmetry. | Tapered tube on a quadratic from the crown surface, accent-coloured tip sphere. Sways in the rig. |
| **Horns** | `forehead/top/side`, honey colour (or brown/ivory on honey bodies), curl, tilt, roundness. | Soft cone (tube + dome) at the same anchors. |
| **Ears** | `round/pointed`, on the head's edge 11.5% down, tilt, flop, cheek-coloured inside. | Ellipsoid or soft leaf with a pink inner, pivoted at the root. |
| **Tail** | `nub/curl/leaf` low on the back, lift, curl. | Sphere / curling tube with accent tip / leaf ellipsoid. |
| **Pattern** | `solid/spotted/striped/gradient`: spots at degrees round the body on a flank and across the back; bands across the back; a deepening toward the base. Secondary colour. | Painted into the body texture at the same angles and heights (`markings/painter.ts`). |
| **Special mark** | `star/heart/sparkle/moon`, one region (forehead/chest/hip/shoulder) chosen by the seed among those the body leaves free. | Painted shape at the same place. |
| **Belly / freckles** | Lighter oval low on the front; three dots per cheek. | Painted. |
| **Expressions** | Six emotions as KEY POSES (mouth, brows, lid, iris scale, blush) blended by weight, in the face's own units; lids close continuously. | `face/expressions.ts` port; brows and mouth are flat ribbons on the skin (`face/stroke.ts`), lids are skin-textured patches that slide over the eye's dome. |
| **Eyes** | A white oval, iris and pupil set low and inward, two highlights on the lit side; lids as the kit's lid curves. | `face/eye.ts`: every part is a patch of the body's skin on one shallow dome (zero at the white's rim), so the eye faces where the skin faces and is the drawing from the front. Gaze slides the inner parts across the drawing; a blink is the lid curve descending over them. |
| **Adult vs baby** | Same genome, a stage plan scales and under-develops traits; the baby is a limbless floating seed. | Adult only in this prototype (the game character). The baby would be a second plan, not a second renderer. |
| **Determinism** | No `Math.random()` in anything identity-derived. | Same: tests pin seed → identity → genome → morphology → vertex data. Runtime animation and blinks use a per-instance seeded stream anyway. |

Properties that map into 3D: body width/height/top width/belly/roundness/lean
(the surface), eye size/spacing/height/tilt/pupil size, mouth width/height/curve,
brow height, cheek size, arm size/height, foot size/spacing, tuft size/tilt/
spread/length, every trait's micro-geometry, all four colours, pattern, mark,
belly, freckles. Nothing is forced where it would look wrong: the profile's
depth follows the kit's side silhouette (which the 2D side view also uses), and
the 2D view-specific effects (the stripes' sag, the lighting that "stays on the
viewer's left") are not reproduced, because in 3D the camera does that.

## Architecture

```
src/blobbi/                     the reusable renderer (future @blobbi-kit/3d)
  identity/     seed, rng, colours, genome, identity   port of the kit, no 3D, fixture-pinned
  morphology/   genes → bounded root-unit numbers      port of the kit, no 3D
  geometry/     plan (the measured artwork), silhouette, body surface, parts (limbs, tuft, traits), units
  markings/     the skin painter (canvas 2D, no Babylon)
  face/         expressions (port) and the 3D face (eyes, lids, brows, mouth)
  materials/    the palette as materials
  rig/          named pivots and plain-number poses
  animation/    motion states → poses (idle, walk, run, jump, fall, land; party-game states reserved)
  renderer/     createBlobbi3D(identity, scene) and the gameplay profile
src/playground/                 one scene, one controllable Blobbi, a panel; no Blobbi logic here
```

`createBlobbi3D(identityOrSeed, scene, options)` returns a handle with the
identity, genome, morphology, surface, rig, parts, face, materials, skin
texture, animator, meshes, and `setExpression`, `setSleeping`, `setGaze`,
`update(input)`, `dispose()`. `createCanonicalBlobbi3D(scene)` is the
comparison point (every gene at zero, the authored purple).

### The face and the traits in 3D

Every drawn feature answers "where is this in space?" with one rule: a point
of the front drawing lies on the body's skin under it (`surface.frontPoint`),
lifted along the skin's true normal by a small, fixed amount. Eyes add a
shallow elliptical dome that is zero at the white's rim; iris, pupil,
highlights and lids are laid on that same dome a hair above one another, so
nothing floats, clips or leaves the white at any gaze or angle. Strokes
(mouth, brows, the closed eye's line) are ribbons of the 2D stroke weight
with round caps. All patches have fixed topology and update positions only.

Traits are rooted at a MOUNT (a surface point with its normal) found by the
kit's own anatomical description, leave the skin along the normal and swing
to the kit's direction rule for their kind (`turnToward`), flare where they
cross the skin (`rootFlare`), and follow the kit's quadratic centre line
(horns) or a cubic that emerges from the skin (antennae, ears, curl tails).
No world-space Euler angles are accumulated.

### Units and frames

One root unit is 1/630.667 m: the canonical body is 1.0 m from base to
crown and the character stands 1.05 m. The character faces +Z. The kit
describes everything in the viewer's frame of the front drawing; `VIEWER_X`
in `geometry/units.ts` is the one constant that converts.

### Visual body vs gameplay body

`renderer/gameplay.ts` declares `BLOBBI_GAMEPLAY_PROFILE`: one normalized
capsule, reach, mass and speeds for every player. Visual morphology varies
by identity; the renderer never reads the profile and a game never derives
colliders from the mesh. The playground's controller moves that capsule and
the visual Blobbi follows it, which is the shape a Havok-backed controller
would take too.

### Animation

`BlobbiAnimator` turns `{ dt, speed, grounded, verticalVelocity, jumped,
landed, impact }` into a pose and eases between states. Walk and run plant
the feet and carry them back (no sliding), bounce and lean the body, swing
the arms and trail the soft parts; jump stretches, fall flails, land
squashes by the impact. `grab`, `push`, `stunned`, `ragdoll`, `getup` are
reserved names: a ragdoll is for the physics engine to pose.

## Tests

`npm test` (vitest, 61 tests): the RNG, genome, identity, palette and adult
morphology against fixtures produced by blobbi-kit's own engine; determinism
(same seed → same identity, genome, morphology, vertex data); bounds and
clamping; stated-field precedence and `inferred`; expression blending and
lids; the body surface (height, width, profile depth, mapping of the face
and of a back spot) and its normals; the 3D face (deterministic eye
geometry, dome conformity, progressive lids, strokes a hair above the skin at
every key pose and blend, open-mouth fill, morphology extremes) and trait
attachment (roots on the skin, tips outside and above, mirrored pairs,
finite), all built with Babylon's `NullEngine`; the animator's state choices
and poses.

The fixture (`src/blobbi/identity/__fixtures__/kit-fixtures.json`) was generated by
bundling the kit's `procedural/` source with esbuild and running it in node.
Regenerate it the same way when the kit's algorithm version changes.

## Limitations

- Adult stage only; no egg, no baby.
- Lighting is Babylon standard materials (no PBR, no environment map).
- The skin texture repaints only when the blush changes; expressions that
  move the brows and mouth update meshes, which is cheap.
- The character controller is a stand-in (gravity and a flat floor), not Havok.
- No LOD, no instancing: one Blobbi is about 45 meshes and 10k vertices.
- The animation set is the demonstration set; there is no blend tree yet.
