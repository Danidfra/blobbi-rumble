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
