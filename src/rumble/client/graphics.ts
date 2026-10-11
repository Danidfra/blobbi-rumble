/**
 * GRAPHICS: can this browser draw the game, and if not, why. Babylon asks
 * for WebGL2 and falls back to WebGL1 by itself, and throws "WebGL not
 * supported" only when the browser gives neither; this module asks first
 * (before a multiplayer page connects, so a page that cannot draw never
 * takes a fighter), keeps the browser's own reason
 * (`webglcontextcreationerror`), and turns a failure into words a player
 * can act on.
 *
 *   probeWebGL()          which WebGL the browser gives, its renderer, and the browser's reason when it gives none
 *   graphicsFailure()     what went wrong: no WebGL at all, WebGL blocked for this site, or the 3D engine failing
 *                         on a working WebGL (ours), or the graphics lost mid-game
 *   graphicsOptions()     developer-only switches (?webgl=1 forces WebGL1; ?webgl=none / ?webgl=fail simulate a
 *                         failure), honoured in development builds and on this machine's own addresses only
 *
 * Pure but for the probe, which takes its canvas factory as a parameter
 * (tests hand it fakes).
 */

export type WebGLVersion = 1 | 2;

export interface WebGLProbe {
  /** The best WebGL the browser gives (null: none). */
  version: WebGLVersion | null;
  webgl2: boolean;
  webgl1: boolean;
  /** The GPU as the browser names it (may be generic or blurred by privacy protections), or null. */
  renderer: string | null;
  /** A software renderer (SwiftShader, llvmpipe, Microsoft Basic Render): it works, slowly. */
  software: boolean;
  /** What the browser said when it refused a context (`webglcontextcreationerror`), if anything. */
  reason: string | null;
}

/** The part of a canvas the probe uses. */
export interface ProbeCanvas {
  getContext(type: string, options?: object): unknown;
  addEventListener(type: string, listener: (e: { statusMessage?: string }) => void): void;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

/** Ask the browser for WebGL2, then WebGL1, each on a fresh canvas; free the contexts again. */
export function probeWebGL(makeCanvas: () => ProbeCanvas, opts: { forceWebGL1?: boolean; simulateNone?: boolean } = {}): WebGLProbe {
  const reasons: string[] = [];
  const attempt = (type: 'webgl2' | 'webgl') => {
    if (opts.simulateNone) {
      reasons.push('simulated: no WebGL (?webgl=none)');
      return null;
    }
    let c: ProbeCanvas;
    try {
      c = makeCanvas();
    } catch {
      return null;
    }
    c.addEventListener('webglcontextcreationerror', (e) => {
      if (e.statusMessage) reasons.push(e.statusMessage);
    });
    try {
      const gl = c.getContext(type) ?? (type === 'webgl' ? c.getContext('experimental-webgl') : null);
      return (gl as WebGLRenderingContext | null) ?? null;
    } catch (e) {
      reasons.push(String((e as Error)?.message ?? e));
      return null;
    }
  };
  const gl2 = opts.forceWebGL1 ? null : attempt('webgl2');
  const gl1 = gl2 ? null : attempt('webgl');
  const gl = gl2 ?? gl1;
  let renderer: string | null = null;
  if (gl) {
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
      const r = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      renderer = typeof r === 'string' && r ? r.slice(0, 160) : null;
    } catch {
      renderer = null;
    }
    // Probe contexts count against the browser's limit: give this one back.
    try {
      (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    } catch {
      // Nothing to free.
    }
  }
  const webgl2 = !!gl2;
  // WebGL1 was only asked for when WebGL2 failed; with WebGL2 it is there too.
  const webgl1 = webgl2 || !!gl1;
  return { version: gl2 ? 2 : gl1 ? 1 : null, webgl2, webgl1, renderer, software: !!renderer && SOFTWARE.test(renderer), reason: reasons.length ? [...new Set(reasons)].join(' · ').slice(0, 300) : null };
}

/**
 * What went wrong, for the words on the screen:
 *   unavailable  the browser gave no WebGL at all (graphics acceleration off, the GPU or driver blocklisted, no GPU
 *                as in a remote desktop or a VM, or WebGL turned off by a setting, a policy or an extension)
 *   blocked      the browser has blocked WebGL for this site, usually after the graphics crashed (a restart clears it)
 *   engine       WebGL works, but the 3D engine failed to start on it (the game's fault, or the driver's)
 *   lost         the graphics were lost mid-game and did not come back
 */
export type GraphicsFailureKind = 'unavailable' | 'blocked' | 'engine' | 'lost';

export interface GraphicsFailure {
  kind: GraphicsFailureKind;
  probe: WebGLProbe;
  /** The error the engine threw, if any. */
  error: string | null;
}

export function graphicsFailure(probe: WebGLProbe, error?: unknown, lost = false): GraphicsFailure {
  const message = error === undefined || error === null ? null : String((error as Error)?.message ?? error).slice(0, 300);
  if (lost) return { kind: 'lost', probe, error: message };
  if (probe.version === null) return { kind: /block|crash|lost|too many/i.test(probe.reason ?? '') ? 'blocked' : 'unavailable', probe, error: message };
  return { kind: 'engine', probe, error: message };
}

/** Words for the error screen: a title, what happened, what to try (in order), and whether a multiplayer slot was involved. */
export function describeFailure(f: GraphicsFailure, context: { online: boolean }): { title: string; summary: string; steps: string[]; note: string | null } {
  const accel = 'Turn on hardware acceleration: in Brave, Chrome or Edge, Settings → System → "Use graphics acceleration when available", then relaunch the browser.';
  const gpuPage = 'Open brave://gpu (or chrome://gpu) and look at the "WebGL" line: "Disabled" or "Unavailable" means the browser has turned 3D graphics off.';
  const shields = 'Turn off Brave Shields or privacy extensions that block WebGL or canvas for this site, or open the game in a private window without extensions.';
  const drivers = 'Update your graphics drivers (and the browser), then try again.';
  const other = 'Try another browser (Firefox, Chrome, Safari) or another device.';
  const remote = 'In a remote desktop or a virtual machine there is often no graphics card for the browser to use.';
  const note = context.online ? 'You were not added to the match (or your place was given back), so nobody is waiting on you.' : null;
  switch (f.kind) {
    case 'unavailable':
      return { title: 'Your browser isn’t providing 3D graphics', summary: 'Blobbi Rumble draws with WebGL, and this browser gave it neither WebGL 2 nor WebGL 1. That usually means graphics acceleration is off, the graphics card or its driver is on the browser’s block list, or WebGL is turned off.', steps: [accel, gpuPage, shields, drivers, remote, other], note };
    case 'blocked':
      return { title: '3D graphics are blocked for this site', summary: 'The browser has blocked WebGL here, usually after the graphics crashed earlier.', steps: ['Quit the browser completely and open it again (a reload is not enough).', accel, gpuPage, drivers, other], note };
    case 'engine':
      return { title: 'The 3D graphics couldn’t start', summary: `WebGL ${f.probe.version} is available, but the game’s 3D engine failed to start on it. That may be a problem with the game or the graphics driver.`, steps: ['Reload the page.', drivers, accel, other, 'If it keeps happening, send us the details below.'], note };
    case 'lost':
      return { title: 'The 3D graphics stopped', summary: 'The browser lost the game’s graphics and did not give them back (the graphics card or its driver may have reset).', steps: ['Reload the page.', 'If it happens again, quit the browser completely and open it again.', drivers, other], note };
  }
}

/** The technical details, as text a player can copy into a message. */
export function failureDetails(f: GraphicsFailure, env: { userAgent: string; page: string }): string {
  const p = f.probe;
  return [
    `problem: ${f.kind}`,
    `WebGL 2: ${p.webgl2 ? 'yes' : 'no'} · WebGL 1: ${p.webgl1 ? 'yes' : 'no'}`,
    `renderer: ${p.renderer ?? 'unknown'}${p.software ? ' (software)' : ''}`,
    `browser said: ${p.reason ?? 'nothing'}`,
    `error: ${f.error ?? 'none'}`,
    `page: ${env.page}`,
    `browser: ${env.userAgent}`,
  ].join('\n');
}

/** Developer-only switches. */
export interface GraphicsOptions {
  /** Ask Babylon for WebGL1 only (disableWebGL2Support), to test the fallback. */
  forceWebGL1: boolean;
  /** Pretend the browser gives no WebGL (the probe fails): the error screen, before any connection. */
  simulateNone: boolean;
  /** Pretend the engine fails to start (after the probe passed): the late failure, after the page joined a match. */
  simulateEngineFailure: boolean;
}

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;

/** `?webgl=1 | none | fail`, honoured in a development build or on this machine's own address only (never on a public host). */
export function graphicsOptions(search: string, env: { dev: boolean; hostname: string }): GraphicsOptions {
  const off: GraphicsOptions = { forceWebGL1: false, simulateNone: false, simulateEngineFailure: false };
  if (!env.dev && !LOCAL_HOSTS.test(env.hostname)) return off;
  const v = new URLSearchParams(search).get('webgl');
  return { forceWebGL1: v === '1', simulateNone: v === 'none', simulateEngineFailure: v === 'fail' };
}

/** Whether the performance overlay was asked for (`?debug=perf`, also among other comma-separated debug flags). */
export const perfOverlayAsked = (search: string) => (new URLSearchParams(search).get('debug') ?? '').split(',').map((s) => s.trim()).includes('perf');
