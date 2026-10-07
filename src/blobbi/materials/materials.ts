/**
 * MATERIALS: the palette's roles as Babylon materials. One set per Blobbi
 * (each has its own palette), shared by every mesh of that Blobbi.
 *
 * The look is deliberately soft and matte, like the 2D drawing's flat
 * shading with one highlight: low specular, a gentle Fresnel rim so the
 * silhouette reads against any ground, and the body's colour carried by a
 * painted texture (gradient, shine, markings, face) rather than by the
 * lighting alone. Standard materials, not PBR: no environment texture to
 * load, and the character looks the same in any host scene's lighting.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { FresnelParameters } from '@babylonjs/core/Materials/fresnelParameters';
import type { Scene } from '@babylonjs/core/scene';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { mixOklab, type BlobbiPalette } from '../identity/colors';

export const color3 = (hex: string) => Color3.FromHexString(hex);

export interface BlobbiMaterials {
  body: StandardMaterial;
  limb: StandardMaterial;
  foot: StandardMaterial;
  accent: StandardMaterial;
  horn: StandardMaterial;
  line: StandardMaterial;
  eyeWhite: StandardMaterial;
  iris: StandardMaterial;
  pupil: StandardMaterial;
  glint: StandardMaterial;
  feature: StandardMaterial;
  cheek: StandardMaterial;
  lid: StandardMaterial;
  all: StandardMaterial[];
  dispose(): void;
}

function matte(name: string, scene: Scene, hex: string, options: { specular?: number; rim?: string; alpha?: number; emissive?: number } = {}): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  const color = color3(hex);
  mat.diffuseColor = color;
  mat.specularColor = Color3.White().scale(options.specular ?? 0.12);
  mat.specularPower = 24;
  if (options.emissive) mat.emissiveColor = color.scale(options.emissive);
  if (options.rim) {
    const fresnel = new FresnelParameters();
    fresnel.bias = 0.3;
    fresnel.power = 2.6;
    fresnel.leftColor = color3(options.rim);
    fresnel.rightColor = Color3.Black();
    mat.emissiveFresnelParameters = fresnel;
  }
  if (options.alpha !== undefined && options.alpha < 1) mat.alpha = options.alpha;
  return mat;
}

export function createBlobbiMaterials(scene: Scene, palette: BlobbiPalette, bodyTexture: BaseTexture, name = 'blobbi'): BlobbiMaterials {
  const body = new StandardMaterial(`${name}-body`, scene);
  body.diffuseTexture = bodyTexture;
  body.specularColor = Color3.White().scale(0.12);
  body.specularPower = 36;
  const rim = new FresnelParameters();
  rim.bias = 0.28;
  rim.power = 3;
  rim.leftColor = color3(mixOklab(palette.bodyLight, '#ffffff', 0.35)).scale(0.22);
  rim.rightColor = Color3.Black();
  body.emissiveFresnelParameters = rim;

  const limbMid = mixOklab(palette.limbLight, palette.limbDark, 0.35);
  const materials: Omit<BlobbiMaterials, 'all' | 'dispose'> = {
    body,
    limb: matte(`${name}-limb`, scene, limbMid, { rim: palette.limbLight, specular: 0.14 }),
    foot: matte(`${name}-foot`, scene, mixOklab(palette.footLight, palette.footDark, 0.3), { rim: palette.footLight, specular: 0.1 }),
    accent: matte(`${name}-accent`, scene, palette.accentLight, { rim: '#ffffff', specular: 0.4, emissive: 0.12 }),
    horn: matte(`${name}-horn`, scene, mixOklab(palette.hornLight, palette.hornDark, 0.4), { rim: palette.hornLight, specular: 0.2 }),
    line: matte(`${name}-line`, scene, palette.line, { specular: 0.05 }),
    eyeWhite: matte(`${name}-eye-white`, scene, palette.white, { specular: 0.5, emissive: 0.18 }),
    iris: matte(`${name}-iris`, scene, palette.irisMid, { specular: 0.3, emissive: 0.08 }),
    pupil: matte(`${name}-pupil`, scene, palette.pupil, { specular: 0.3 }),
    glint: matte(`${name}-glint`, scene, '#ffffff', { specular: 0, emissive: 0.9 }),
    feature: matte(`${name}-feature`, scene, palette.feature, { specular: 0.04 }),
    cheek: matte(`${name}-cheek`, scene, palette.cheek, { specular: 0.1 }),
    lid: matte(`${name}-lid`, scene, mixOklab(palette.bodyMid, palette.bodyLight, 0.25), { specular: 0.12 }),
  };
  materials.pupil.specularPower = 64;
  materials.eyeWhite.specularPower = 48;
  const all = Object.values(materials);
  return {
    ...materials,
    all,
    dispose: () => {
      for (const mat of all) mat.dispose();
    },
  };
}
