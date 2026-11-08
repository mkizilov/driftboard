import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeSync } from './indicator';
import type { ConnectionStatus, SyncState } from './sync-connection';

const state = (status: ConnectionStatus, pending: number, failures = 0): SyncState => ({
  status,
  pending,
  failures,
});

describe('describeSync', () => {
  it('is online when connected and the server has everything', () => {
    expect(describeSync(state('online', 0))).toEqual({
      kind: 'online',
      label: 'Online',
      pending: 0,
      detail: null,
    });
  });

  it('is syncing while connected and changes are still going out', () => {
    expect(describeSync(state('online', 3))).toEqual({
      kind: 'syncing',
      label: 'Syncing…',
      pending: 3,
      detail: '3 pending changes',
    });
  });

  it('says "change" for one', () => {
    expect(describeSync(state('online', 1)).detail).toBe('1 pending change');
    expect(describeSync(state('offline', 1)).detail).toBe('1 pending change');
  });

  it('is syncing during the first connection attempt, so opening a board does not flash offline', () => {
    expect(describeSync(state('connecting', 0, 0))).toMatchObject({
      kind: 'syncing',
      detail: null,
    });
    expect(describeSync(state('connecting', 4, 0))).toMatchObject({
      kind: 'syncing',
      detail: '4 pending changes',
    });
  });

  it('is offline when not connected, with the number of changes waiting', () => {
    expect(describeSync(state('offline', 0))).toEqual({
      kind: 'offline',
      label: 'Offline',
      pending: 0,
      detail: null,
    });
    expect(describeSync(state('offline', 12))).toEqual({
      kind: 'offline',
      label: 'Offline',
      pending: 12,
      detail: '12 pending changes',
    });
  });

  it('stays offline while retrying after a failed attempt', () => {
    expect(describeSync(state('connecting', 2, 1)).kind).toBe('offline');
    expect(describeSync(state('connecting', 0, 5)).kind).toBe('offline');
  });

  it('always reports the number of pending changes, and a detail exactly when there are some', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ConnectionStatus>('online', 'connecting', 'offline'),
        fc.nat(50),
        fc.nat(4),
        (status, pending, failures) => {
          const indicator = describeSync(state(status, pending, failures));
          return indicator.pending === pending && (indicator.detail !== null) === pending > 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});
