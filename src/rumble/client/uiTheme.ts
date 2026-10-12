/**
 * THE INTERFACE'S LOOK (L4.2): one small set of tokens and parts that every
 * card, chip, sheet and button of the game's shell is drawn with. Soft,
 * rounded and pastel, readable over a bright sky or a dark arena (frosted
 * backdrops, a dark ink on pale fills, never white text on a pastel), and
 * quiet: no glow, no animation but a press and a gentle fade (none at all
 * for anyone who asked their system for less motion).
 *
 *   tokens      --rs-* colours, radii, shadows and the rounded type
 *   buttons     .rs-btn (plain), .go (the one main action), .soft, .warn,
 *               .icon (a round one-glyph button), [disabled]
 *   surfaces    .rs-card (a card), .rs-glass (a frosted chip over the world),
 *               .rs-sheet (the one expandable panel at a time)
 *   bits        .rs-pill (a status badge), .rs-tabs, .rs-seg (two-way),
 *               .rs-sec (a section heading), .rs-input / .rs-link (fields)
 *   focus       a clear ring for the keyboard (:focus-visible), none for a
 *               mouse or a finger
 */
export const THEME_CSS = `
  :root {
    --rs-ink: #2a2944; --rs-sub: #5b5f78; --rs-faint: #8b8fa7; --rs-line: #e6e7f2; --rs-wash: #f5f5fb;
    --rs-card: rgba(255,255,255,0.96); --rs-glass: rgba(255,255,255,0.86);
    --rs-mint: #8fe0b0; --rs-mint-ink: #0f4a2c; --rs-mint-edge: #5cc58a; --rs-mint-soft: #e2f6ea;
    --rs-pink: #ff9fbf; --rs-pink-soft: #ffe8f0; --rs-lilac: #8f7cf0; --rs-lilac-soft: #efebff;
    --rs-sun: #ffd166; --rs-sun-soft: #fff2cc; --rs-sun-ink: #7a4b00;
    --rs-sky-soft: #e2f0fc; --rs-sky-ink: #23466e; --rs-red-soft: #fde3e1; --rs-red-ink: #8f2f2b;
    --rs-shadow: 0 10px 34px rgba(52,46,98,0.20); --rs-shadow-sm: 0 3px 12px rgba(52,46,98,0.14);
    --rs-r: 20px; --rs-r-md: 14px; --rs-r-sm: 10px;
    --rs-font: ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, -apple-system, "Segoe UI", sans-serif;
    --rs-focus: #6d5bf0;
    --rs-safe-t: env(safe-area-inset-top, 0px); --rs-safe-r: env(safe-area-inset-right, 0px); --rs-safe-b: env(safe-area-inset-bottom, 0px); --rs-safe-l: env(safe-area-inset-left, 0px);
  }
  .rs-ui, .rs-card, .rs-glass, .rs-top, .rs-banner, .rs-toasts { font-family: var(--rs-font); color: var(--rs-ink); -webkit-font-smoothing: antialiased; }
  .rs-ui *, .rs-card *, .rs-top *, .rs-banner * { box-sizing: border-box; }
  .rs-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 13px; border: 1.5px solid var(--rs-line); border-radius: var(--rs-r-md); background: #fff; color: var(--rs-ink); font: 700 13px var(--rs-font); line-height: 1.1; cursor: pointer; white-space: nowrap; transition: transform 0.08s ease, box-shadow 0.12s ease, background 0.12s ease; -webkit-tap-highlight-color: transparent; }
  .rs-btn:hover { box-shadow: var(--rs-shadow-sm); }
  .rs-btn:active { transform: scale(0.97); }
  .rs-btn.go { border-color: var(--rs-mint-edge); background: var(--rs-mint); color: var(--rs-mint-ink); }
  .rs-btn.go:hover { background: #a3e8bf; }
  .rs-btn.soft { border-color: transparent; background: var(--rs-wash); }
  .rs-btn.warn { border-color: #f3c3bf; background: var(--rs-red-soft); color: var(--rs-red-ink); }
  .rs-btn.on { border-color: var(--rs-lilac); background: var(--rs-lilac-soft); color: #3a2c8f; }
  .rs-btn.icon { width: 36px; min-width: 36px; padding: 0; border-radius: 50%; font-size: 16px; }
  .rs-btn[disabled] { opacity: 0.45; cursor: default; box-shadow: none; transform: none; }
  .rs-btn .ic { font-size: 15px; line-height: 1; }
  .rs-ui :focus-visible, .rs-card :focus-visible, .rs-top :focus-visible, .rs-banner :focus-visible { outline: 3px solid var(--rs-focus); outline-offset: 2px; }
  .rs-ui :focus:not(:focus-visible), .rs-card :focus:not(:focus-visible), .rs-top :focus:not(:focus-visible) { outline: none; }
  .rs-card { position: fixed; z-index: 6; border-radius: var(--rs-r); background: var(--rs-card); box-shadow: var(--rs-shadow); font-size: 13px; }
  .rs-glass { background: var(--rs-glass); -webkit-backdrop-filter: blur(10px) saturate(1.2); backdrop-filter: blur(10px) saturate(1.2); box-shadow: var(--rs-shadow-sm); }
  .rs-pill { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 2px 9px; border-radius: 999px; background: var(--rs-wash); color: var(--rs-sub); font: 700 11px var(--rs-font); white-space: nowrap; }
  .rs-pill.ready { background: var(--rs-mint-soft); color: var(--rs-mint-ink); }
  .rs-pill.wait { background: var(--rs-sun-soft); color: var(--rs-sun-ink); }
  .rs-pill.bot { background: var(--rs-sky-soft); color: var(--rs-sky-ink); }
  .rs-pill.left { background: var(--rs-red-soft); color: var(--rs-red-ink); }
  .rs-pill.own { background: var(--rs-sun-soft); color: var(--rs-sun-ink); }
  .rs-pill.you { background: var(--rs-lilac-soft); color: #3a2c8f; }
  .rs-sec { margin: 14px 0 6px; font: 800 11px var(--rs-font); letter-spacing: 0.08em; text-transform: uppercase; color: var(--rs-faint); }
  .rs-sec:first-child { margin-top: 2px; }
  .rs-tabs { display: flex; gap: 4px; padding: 4px; margin: 10px 0 8px; border-radius: var(--rs-r-md); background: var(--rs-wash); }
  .rs-tabs .rs-btn { flex: 1; min-width: 0; border: none; background: none; padding: 6px 6px; color: var(--rs-sub); }
  .rs-tabs .rs-btn[aria-selected="true"] { background: #fff; color: var(--rs-ink); box-shadow: var(--rs-shadow-sm); }
  .rs-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: var(--rs-r-md); background: var(--rs-wash); }
  .rs-seg .rs-btn { border: none; background: none; min-height: 28px; padding: 4px 12px; color: var(--rs-sub); }
  .rs-seg .rs-btn.on { background: #fff; color: var(--rs-ink); box-shadow: var(--rs-shadow-sm); }
  .rs-sheet { width: min(360px, calc(100vw - 20px)); max-height: calc(100dvh - var(--rs-safe-t) - var(--rs-safe-b) - 74px); top: calc(var(--rs-safe-t) + 60px); overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 14px 16px 16px; display: none; }
  .rs-sheet.left { left: calc(var(--rs-safe-l) + 10px); }
  .rs-sheet.right { right: calc(var(--rs-safe-r) + 10px); }
  .rs-sheet .hd { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .rs-sheet .hd .ttl { flex: 1; min-width: 0; }
  .rs-sheet .hd h3 { margin: 0; font: 800 17px var(--rs-font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-sheet .hd .rs-sub { display: block; }
  .rs-sheet .foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1.5px solid var(--rs-line); }
  .rs-sheet details { margin-top: 10px; border-radius: var(--rs-r-md); background: var(--rs-wash); padding: 2px 10px; }
  .rs-sheet details[open] { padding-bottom: 10px; }
  .rs-sheet summary { cursor: pointer; padding: 8px 0; font: 700 13px var(--rs-font); color: var(--rs-ink); list-style-position: inside; }
  .rs-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .rs-grid2 .rs-btn { width: 100%; }
  .rs-btn.wide { width: 100%; }
  @media (pointer: coarse) {
    .rs-btn { min-height: 40px; font-size: 14px; }
    .rs-btn.icon { width: 40px; min-width: 40px; }
    .rs-seg .rs-btn { min-height: 34px; }
  }
  @media (max-height: 520px) {
    .rs-sheet { top: calc(var(--rs-safe-t) + 52px); max-height: calc(100dvh - var(--rs-safe-t) - var(--rs-safe-b) - 60px); width: min(380px, 54vw); padding: 10px 12px 12px; }
    .rs-sheet .hd h3 { font-size: 15px; }
    .rs-tabs { margin: 6px 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rs-btn, .rs-btn:active { transition: none; transform: none; }
    .rs-ui *, .rs-card *, .rs-banner * { animation: none !important; transition: none !important; }
  }
`;
