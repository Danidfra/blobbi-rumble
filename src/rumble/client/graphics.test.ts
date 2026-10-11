/** WebGL detection, the failure words, and the developer-only switches (`graphics.ts`), with fake canvases. */
import { describe, expect, it } from 'vitest';
import { describeFailure, failureDetails, graphicsFailure, graphicsOptions, perfOverlayAsked, probeWebGL, type ProbeCanvas } from './graphics';

/** A fake browser: which context types it gives, what it says when it refuses, and what renderer it reports. */
function browser(opts: { gives?: string[]; refuse?: string; renderer?: string; throws?: boolean }) {
  const asked: string[] = [];
  let lost = 0;
  const make = (): ProbeCanvas => {
    const listeners: ((e: { statusMessage?: string }) => void)[] = [];
    return {
      addEventListener: (_t, l) => listeners.push(l),
      getContext(type: string) {
        asked.push(type);
        if (opts.throws) throw new Error('context creation threw');
        if (!(opts.gives ?? []).includes(type)) {
          if (opts.refuse) for (const l of listeners) l({ statusMessage: opts.refuse });
          return null;
        }
        return {
          RENDERER: 0x1f01,
          getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : name === 'WEBGL_lose_context' ? { loseContext: () => (lost += 1) } : null),
          getParameter: (p: number) => (p === 0x9246 ? (opts.renderer ?? 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620)') : 'WebKit WebGL'),
        };
      },
    };
  };
  return { make, asked, lost: () => lost };
}

describe('probing WebGL', () => {
  it('WebGL2 first; the context is given back; the renderer is read', () => {
    const b = browser({ gives: ['webgl2', 'webgl'] });
    const p = probeWebGL(b.make);
    expect(p).toMatchObject({ version: 2, webgl2: true, webgl1: true, software: false, reason: null });
    expect(p.renderer).toMatch(/Intel/);
    expect(b.asked).toEqual(['webgl2']);
    expect(b.lost()).toBe(1);
  });

  it('WebGL1 when WebGL2 is not given (as Babylon falls back)', () => {
    const b = browser({ gives: ['webgl'] });
    expect(probeWebGL(b.make)).toMatchObject({ version: 1, webgl2: false, webgl1: true });
    expect(b.asked).toEqual(['webgl2', 'webgl']);
  });

  it('forcing WebGL1 never asks for WebGL2', () => {
    const b = browser({ gives: ['webgl2', 'webgl'] });
    expect(probeWebGL(b.make, { forceWebGL1: true }).version).toBe(1);
    expect(b.asked).toEqual(['webgl']);
  });

  it('none at all: the browser’s own reason is kept', () => {
    const b = browser({ refuse: 'Web page caused context loss and was blocked' });
    const p = probeWebGL(b.make);
    expect(p).toMatchObject({ version: null, webgl2: false, webgl1: false, renderer: null });
    expect(p.reason).toBe('Web page caused context loss and was blocked');
    expect(b.asked).toEqual(['webgl2', 'webgl', 'experimental-webgl']);
  });

  it('a getContext that throws is a refusal, not a crash', () => {
    const p = probeWebGL(browser({ throws: true }).make);
    expect(p.version).toBeNull();
    expect(p.reason).toMatch(/threw/);
    expect(probeWebGL(() => { throw new Error('no canvas'); }).version).toBeNull();
  });

  it('tells a software renderer apart', () => {
    for (const r of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver']) expect(probeWebGL(browser({ gives: ['webgl2'], renderer: r }).make).software).toBe(true);
    expect(probeWebGL(browser({ gives: ['webgl2'], renderer: 'Apple M2' }).make).software).toBe(false);
  });

  it('simulating no WebGL asks the browser for nothing', () => {
    const b = browser({ gives: ['webgl2', 'webgl'] });
    const p = probeWebGL(b.make, { simulateNone: true });
    expect(p.version).toBeNull();
    expect(p.reason).toMatch(/simulated/);
    expect(b.asked).toEqual([]);
  });
});

describe('what a player is told', () => {
  const none = probeWebGL(browser({}).make);
  const blocked = probeWebGL(browser({ refuse: 'WebGL has been blocked for this site because of GPU crashes' }).make);
  const works = probeWebGL(browser({ gives: ['webgl2'] }).make);

  it('no WebGL, WebGL blocked, the engine failing on working WebGL, and graphics lost are four different stories', () => {
    expect(graphicsFailure(none).kind).toBe('unavailable');
    expect(graphicsFailure(blocked).kind).toBe('blocked');
    expect(graphicsFailure(works, new Error('WebGL not supported')).kind).toBe('engine');
    expect(graphicsFailure(works, 'context lost', true).kind).toBe('lost');
    // Even a "WebGL not supported" error on a working probe is the engine's failure, not the browser's.
    expect(graphicsFailure(works, new Error('WebGL not supported')).error).toBe('WebGL not supported');
  });

  it('the words point at what to do: acceleration, the GPU page, extensions, another browser; a restart when blocked', () => {
    const u = describeFailure(graphicsFailure(none), { online: true });
    expect(u.title).toMatch(/isn’t providing 3D graphics/);
    expect(u.steps.join(' ')).toMatch(/graphics acceleration/);
    expect(u.steps.join(' ')).toMatch(/brave:\/\/gpu/);
    expect(u.steps.join(' ')).toMatch(/Shields/);
    expect(u.steps.join(' ')).toMatch(/another browser/);
    expect(u.note).toMatch(/not added to the match/);
    expect(describeFailure(graphicsFailure(none), { online: false }).note).toBeNull();
    expect(describeFailure(graphicsFailure(blocked), { online: false }).steps[0]).toMatch(/Quit the browser/);
    expect(describeFailure(graphicsFailure(works, 'x'), { online: false }).summary).toMatch(/WebGL 2 is available/);
    expect(describeFailure(graphicsFailure(works, 'x', true), { online: false }).title).toMatch(/stopped/);
  });

  it('the details to copy say what the browser gave, what it said and what failed', () => {
    const d = failureDetails(graphicsFailure(blocked, new Error('boom')), { userAgent: 'UA/1', page: 'https://rumble.example/rumble.html' });
    expect(d).toMatch(/problem: blocked/);
    expect(d).toMatch(/WebGL 2: no · WebGL 1: no/);
    expect(d).toMatch(/browser said: WebGL has been blocked/);
    expect(d).toMatch(/error: boom/);
    expect(d).toMatch(/browser: UA\/1/);
  });
});

describe('developer-only switches', () => {
  it('?webgl=1 / none / fail work in a development build and on this machine, never on a public host', () => {
    expect(graphicsOptions('?webgl=1', { dev: true, hostname: 'rumble.blobbi.pet' }).forceWebGL1).toBe(true);
    for (const h of ['localhost', '127.0.0.1', '[::1]']) expect(graphicsOptions('?webgl=1', { dev: false, hostname: h }).forceWebGL1).toBe(true);
    expect(graphicsOptions('?webgl=none', { dev: false, hostname: 'localhost' }).simulateNone).toBe(true);
    expect(graphicsOptions('?webgl=fail', { dev: false, hostname: 'localhost' }).simulateEngineFailure).toBe(true);
    for (const v of ['1', 'none', 'fail']) expect(Object.values(graphicsOptions(`?webgl=${v}`, { dev: false, hostname: 'rumble.blobbi.pet' })).some(Boolean)).toBe(false);
    expect(Object.values(graphicsOptions('', { dev: true, hostname: 'localhost' })).some(Boolean)).toBe(false);
  });

  it('the performance overlay only with ?debug=perf (alone or among other debug flags)', () => {
    expect(perfOverlayAsked('?debug=perf')).toBe(true);
    expect(perfOverlayAsked('?network=1&debug=net,perf')).toBe(true);
    expect(perfOverlayAsked('')).toBe(false);
    expect(perfOverlayAsked('?debug=1')).toBe(false);
    expect(perfOverlayAsked('?perf=1')).toBe(false);
  });
});
