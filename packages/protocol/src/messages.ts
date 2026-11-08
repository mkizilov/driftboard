import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const nonEmpty = z.string().min(1);

export const helloSchema = z
  .object({
    type: z.literal('hello'),
    version: z.literal(PROTOCOL_VERSION),
    boardId: nonEmpty,
    clientId: nonEmpty,
  })
  .strict();

export const welcomeSchema = z
  .object({
    type: z.literal('welcome'),
    version: z.literal(PROTOCOL_VERSION),
  })
  .strict();

export const errorSchema = z
  .object({
    type: z.literal('error'),
    code: z.enum(['invalid_message']),
    message: z.string(),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion('type', [helloSchema]);
export const serverMessageSchema = z.discriminatedUnion('type', [welcomeSchema, errorSchema]);

export type Hello = z.infer<typeof helloSchema>;
export type Welcome = z.infer<typeof welcomeSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function parseJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, message: result.data };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseJson(clientMessageSchema, raw);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseJson(serverMessageSchema, raw);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
