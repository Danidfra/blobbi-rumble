/**
 * AN ARENA THEME: what an arena LOOKS like, and nothing of what it is. The
 * floor's shape, the colliders, the spawns, the orbs and the sweeper are
 * the match's (`arena/layout.ts`, `sim/`); a theme only colours them in.
 * Another theme (snow, candy, a night garden) is another one of these.
 *
 * The first theme, GARDEN: a small floating lawn high in a bright sky. The
 * grass is a cool, slightly minty green so the four Blobbis (yellow, pink,
 * blue, lime) all stand out from it; the boundary of play is a cream trim
 * over a darker band of grass, and below it warm soil and rock fall away
 * into the sky.
 */
export interface ArenaTheme {
  name: string;
  /** The sky: zenith to horizon, and below the horizon (looking down past the island). */
  skyTop: string;
  skyHorizon: string;
  skyBelow: string;
  /** Fog colour for distant things (the horizon). */
  fog: string;
  /** The lawn: the two tones of its mowed checker, the speckle of blades, the darker band inside the rim, and the trim at the rim itself. */
  grassA: string;
  grassB: string;
  grassFleck: string;
  grassEdge: string;
  edgeTrim: string;
  /** The soil body under the turf, its bands, and the rock underside. */
  soilTop: string;
  soil: string;
  soilBand: string;
  rock: string;
  rockDark: string;
  /** The sweeper: its padded bar's two stripes, its pole and its cap. */
  sweeperA: string;
  sweeperB: string;
  sweeperPole: string;
  sweeperCap: string;
  /** The sweeper's patch of worn grass. */
  sweeperZone: string;
  /** Power orbs. */
  orb: string;
  orbGlow: string;
  /** Decoration: petal colours, flower hearts, stones, mushroom caps, tuft green. */
  petals: string[];
  flowerHeart: string;
  stone: string;
  mushroomCap: string;
  tuft: string;
  cloud: string;
  /** Lighting. */
  sun: string;
  skyLight: string;
  groundBounce: string;
}

export const GARDEN: ArenaTheme = Object.freeze({
  name: 'garden',
  skyTop: '#7fb8f0',
  skyHorizon: '#d9ecfb',
  skyBelow: '#b9d8f2',
  fog: '#d4e7f8',
  grassA: '#6fc38f',
  grassB: '#62b784',
  grassFleck: '#86d3a0',
  grassEdge: '#4f9e70',
  edgeTrim: '#f6efd9',
  soilTop: '#7a5338',
  soil: '#b07a4f',
  soilBand: '#c99062',
  rock: '#9d8a7d',
  rockDark: '#7d6c62',
  sweeperA: '#ff6f61',
  sweeperB: '#fff3e2',
  sweeperPole: '#f2c14e',
  sweeperCap: '#ff8fb1',
  sweeperZone: '#86b97f',
  orb: '#ffd33d',
  orbGlow: '#fff2a8',
  petals: ['#ffffff', '#ffd6e7', '#fff1a8', '#d8c8ff'],
  flowerHeart: '#ffc93c',
  stone: '#dcd6cc',
  mushroomCap: '#ff8a7a',
  tuft: '#58a877',
  cloud: '#ffffff',
  sun: '#fff4e2',
  skyLight: '#f3f8ff',
  groundBounce: '#9fc7a8',
});
