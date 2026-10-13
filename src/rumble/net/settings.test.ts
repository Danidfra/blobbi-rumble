/**
 * L4.7B.1: numeric server settings are checked at start. Unset or empty
 * takes the default; a typo, a fraction, a sign or an out-of-range value
 * stops the server with the reason, instead of becoming NaN (a NaN limit
 * limits nothing).
 */
import { describe, expect, it } from 'vitest';
import { NUMBER_SETTINGS, numberSetting, numberSettings } from './settings';

describe('numeric server settings (L4.7B.1)', () => {
  it('unset or empty: the defaults (64 connections, 16 rooms, 20 idle minutes, 60 Hz, 20 Hz, port 8080)', () => {
    expect(numberSettings({})).toEqual({ PORT: 8080, MAX_CONNECTIONS: 64, MAX_ROOMS: 16, ROOM_IDLE_MINUTES: 20, TICK_HZ: 60, SNAPSHOT_HZ: 20 });
    expect(numberSetting({ MAX_CONNECTIONS: '' }, 'MAX_CONNECTIONS')).toBe(64);
    expect(numberSetting({ MAX_CONNECTIONS: '  ' }, 'MAX_CONNECTIONS')).toBe(64);
  });

  it('whole numbers in range are taken (spaces around are fine); ROOM_IDLE_MINUTES=0 turns idle closing off', () => {
    expect(numberSetting({ MAX_CONNECTIONS: ' 32 ' }, 'MAX_CONNECTIONS')).toBe(32);
    expect(numberSetting({ ROOM_IDLE_MINUTES: '0' }, 'ROOM_IDLE_MINUTES')).toBe(0);
    expect(numberSetting({ MAX_ROOMS: '2' }, 'MAX_ROOMS')).toBe(2);
  });

  it('anything else stops the server with the reason, never NaN or a silent fallback', () => {
    for (const bad of ['6O', 'sixty', '-1', '+5', '64.5', '1e3', '0x40', '64 rooms', 'NaN', 'Infinity']) expect(() => numberSetting({ MAX_CONNECTIONS: bad }, 'MAX_CONNECTIONS'), bad).toThrow(/MAX_CONNECTIONS.*not a whole number/);
    expect(() => numberSetting({ MAX_CONNECTIONS: '0' }, 'MAX_CONNECTIONS')).toThrow(/out of range/);
    expect(() => numberSetting({ MAX_ROOMS: '1' }, 'MAX_ROOMS')).toThrow(/out of range/);
    expect(() => numberSetting({ PORT: '70000' }, 'PORT')).toThrow(/out of range/);
    expect(() => numberSetting({ TICK_HZ: '0' }, 'TICK_HZ')).toThrow(/out of range/);
    expect(() => numberSettings({ SNAPSHOT_HZ: 'fast' })).toThrow(/SNAPSHOT_HZ/);
  });

  it('every default is inside its own range', () => {
    for (const [name, s] of Object.entries(NUMBER_SETTINGS)) {
      expect(s.default, name).toBeGreaterThanOrEqual(s.min);
      expect(s.default, name).toBeLessThanOrEqual(s.max);
    }
  });
});
