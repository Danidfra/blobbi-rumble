/**
 * BLOBBI RUMBLE, THE BROWSER CLIENT. Two ways to play, one presenter:
 *
 *   rumble.html              LOCAL: the match runs in this page (P1/P2 keys, P3/P4 bots)
 *   rumble.html?network=1    NETWORK: the match runs on the server (`npm run server`);
 *                            this page sends its player's intent and draws the server's state
 *   /play/<room>             NETWORK, in that room (a share link)
 *
 * Either way the authority is `sim/match.ts` and this page only draws its
 * snapshots (`client/presenter.ts`); the kit package knows nothing of any
 * of this.
 */
import { startLocal } from './client/local';
import { startNetwork } from './client/network';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const network = new URLSearchParams(location.search).has('network') || location.pathname.startsWith('/play/');

(network ? startNetwork(canvas, hud) : startLocal(canvas, hud)).catch((err) => {
  hud.textContent = `Blobbi Rumble failed to start: ${err}`;
  console.error(err);
});
