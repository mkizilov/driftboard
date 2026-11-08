import { randomBytes } from 'node:crypto';
import { generateBoardId as generateFrom } from '@driftboard/protocol';

export { BOARD_ID_PATTERN, isValidBoardId } from '@driftboard/protocol';

/** A fresh random board id: 128 bits as 22 base64url characters. */
export function generateBoardId(): string {
  return generateFrom((length) => randomBytes(length));
}
