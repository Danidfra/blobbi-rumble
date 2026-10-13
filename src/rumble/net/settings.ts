/**
 * L4.7B.1: the server's numeric settings from the environment, checked. An
 * unset (or empty) variable takes its default; anything else must be a
 * whole number in range, or the server stops at start with the reason. (A
 * typo used to become NaN, and a NaN limit limits nothing: `MAX_CONNECTIONS=6O`
 * meant no connection cap at all.)
 */

export interface NumberSetting {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/** Every numeric setting `serve-cli` reads, with its default and the range it accepts. */
export const NUMBER_SETTINGS = Object.freeze({
  PORT: { default: 8080, min: 1, max: 65_535 },
  MAX_CONNECTIONS: { default: 64, min: 1, max: 10_000 },
  MAX_ROOMS: { default: 16, min: 2, max: 1_000 },
  // 0 turns idle closing off.
  ROOM_IDLE_MINUTES: { default: 20, min: 0, max: 24 * 60 },
  TICK_HZ: { default: 60, min: 10, max: 240 },
  SNAPSHOT_HZ: { default: 20, min: 1, max: 60 },
} satisfies Record<string, NumberSetting>);

export type NumberSettingName = keyof typeof NUMBER_SETTINGS;

/** One setting's value: its default when unset or empty, else the whole number given; throws with the reason otherwise. */
export function numberSetting(env: Record<string, string | undefined>, name: NumberSettingName): number {
  const spec: NumberSetting = NUMBER_SETTINGS[name];
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return spec.default;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}=${JSON.stringify(raw)} is not a whole number`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) throw new Error(`${name}=${raw} is out of range (${spec.min}–${spec.max})`);
  return n;
}

/** All of them at once (the first bad one throws). */
export function numberSettings(env: Record<string, string | undefined>): Record<NumberSettingName, number> {
  const out = {} as Record<NumberSettingName, number>;
  for (const name of Object.keys(NUMBER_SETTINGS) as NumberSettingName[]) out[name] = numberSetting(env, name);
  return out;
}
