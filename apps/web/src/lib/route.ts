import { isValidBoardId } from '@driftboard/protocol';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'board'; readonly boardId: string }
  | { readonly name: 'not-found' };

/** Maps a URL path to a page: `/` is the home page and `/b/:boardId` a board. */
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '') return { name: 'home' };
  const match = /^\/b\/([^/]+)$/.exec(path);
  const boardId = match?.[1];
  if (boardId !== undefined && isValidBoardId(boardId)) return { name: 'board', boardId };
  return { name: 'not-found' };
}

export function boardPath(boardId: string): string {
  return `/b/${boardId}`;
}
