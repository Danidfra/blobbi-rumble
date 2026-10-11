/**
 * A SMALL PICTURE OF A BLOBBI (M9A): the kit's own 2D drawing of the
 * Blobbi's visual identity, as an image URL for an <img>. The renderer is
 * loaded only when a picture is first needed (it carries the V1 / V2
 * artwork), and its SVG never touches the page as markup: it goes into a
 * data: URL, which an <img> shows without running anything in it.
 */
import type { OwnedBlobbi } from './blobbis';

type Renderer = typeof import('@blobbi-kit/renderer');
let renderer: Promise<Renderer> | null = null;
/** Why the last picture could not be made (diagnostics for tests; never shown). */
export let lastPreviewError: unknown = null;

/** The picture, or null when the kit cannot draw this one. Never throws. */
export async function blobbiPreview(b: OwnedBlobbi): Promise<string | null> {
  try {
    let mod: Renderer;
    try {
      renderer ??= import('@blobbi-kit/renderer');
      mod = await renderer;
    } catch (e) {
      // A failed load is not held against the next picture.
      renderer = null;
      throw e;
    }
    const { renderBlobbiSvg } = mod;
    const { svg } = renderBlobbiSvg({ ...b.visual, instanceId: `rumble-${b.d}`, motionPhase: 0 });
    // Some authored artwork opens with an XML declaration or whitespace; a picture is still one <svg> root.
    if (typeof svg !== 'string' || !/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(svg) || svg.length > 400_000) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch (e) {
    lastPreviewError = e;
    return null;
  }
}

/** L3: pictures of Rumble looks already made, by look (a few seats' worth: bounded). */
const lookPictures = new Map<string, Promise<string | null>>();

/**
 * L3: a small picture of a fighter's Rumble look (an adult procedural Blobbi
 * from its seed, wearing a legacy Blobbi's own colours when it has them):
 * the lobby's seat previews, for a worn form and a default fighter alike.
 * The same look is drawn once. Never throws; null when the kit cannot draw it.
 */
export function lookPreview(look: { seed: string; algorithm: 1; colors?: { base: string; secondary: string; eye: string } }): Promise<string | null> {
  const key = `${look.seed}|${look.colors ? `${look.colors.base}${look.colors.secondary}${look.colors.eye}` : ''}`;
  const known = lookPictures.get(key);
  if (known) return known;
  if (lookPictures.size > 64) lookPictures.clear();
  const visual = { stage: 'adult', visualGeneration: 'v3', v3: look, baseColor: look.colors?.base ?? '#cccccc', secondaryColor: look.colors?.secondary ?? '#aaaaaa', eyeColor: look.colors?.eye ?? '#222222', pattern: 'solid', specialMark: 'none', size: 'medium' } as unknown as OwnedBlobbi['visual'];
  const picture = blobbiPreview({ d: `look-${look.seed.slice(0, 12)}`, visual } as OwnedBlobbi);
  lookPictures.set(key, picture);
  return picture;
}
