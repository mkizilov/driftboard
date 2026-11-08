import { generateBoardId } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { boardPath, parseRoute } from './route';

const boardId = generateBoardId((length) =>
  Uint8Array.from({ length }, (_, index) => index * 7 + 3),
);

describe('parseRoute', () => {
  it('shows the start page at the root', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('')).toEqual({ name: 'home' });
  });

  it('opens a board at /b/:boardId', () => {
    expect(parseRoute(`/b/${boardId}`)).toEqual({ name: 'board', boardId });
  });

  it('ignores trailing slashes', () => {
    expect(parseRoute(`/b/${boardId}/`)).toEqual({ name: 'board', boardId });
    expect(parseRoute('//')).toEqual({ name: 'home' });
  });

  it('does not open a board for an id the server would refuse', () => {
    expect(parseRoute('/b/short')).toEqual({ name: 'not-found' });
    expect(parseRoute(`/b/${boardId}!`)).toEqual({ name: 'not-found' });
    expect(parseRoute('/b/')).toEqual({ name: 'not-found' });
    expect(parseRoute('/b')).toEqual({ name: 'not-found' });
  });

  it('reports everything else as not found', () => {
    expect(parseRoute('/elsewhere')).toEqual({ name: 'not-found' });
    expect(parseRoute(`/b/${boardId}/extra`)).toEqual({ name: 'not-found' });
    expect(parseRoute(`/x/b/${boardId}`)).toEqual({ name: 'not-found' });
  });
});

describe('boardPath', () => {
  it('builds the address parseRoute understands', () => {
    expect(boardPath(boardId)).toBe(`/b/${boardId}`);
    expect(parseRoute(boardPath(boardId))).toEqual({ name: 'board', boardId });
  });
});
