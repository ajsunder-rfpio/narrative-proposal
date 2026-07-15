// Web-standard HTTP helpers, shared by every edge handler. Uses only
// Request/Response/fetch (available in both Deno and Node 18+), so the handler
// logic these support is testable under vitest and deployable under Deno.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Resolves a bearer token to a caller identity, or null if invalid. */
export type TokenVerifier = (
  token: string,
) => Promise<{ userId: string } | null> | { userId: string } | null;

/**
 * Enforce authentication. No `Authorization: Bearer <token>` header => 401
 * before any work; an invalid token => 401. This is the real reject-path the
 * handler tests exercise.
 */
export async function requireAuth(
  req: Request,
  verify: TokenVerifier,
): Promise<{ userId: string }> {
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "missing bearer token");
  const result = await verify(match[1]);
  if (!result) throw new HttpError(401, "invalid token");
  return result;
}

/** Wrap a handler so HttpError becomes its status and anything else is a 500. */
export function withErrors(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      return json(500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
