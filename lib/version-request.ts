import { authorIdFor, resolveBindings, VersionError, type VersionBindings } from './version-store';

/**
 * Shared request plumbing for the `/api/versions` handlers. Kept out of the
 * route files (and free of any `cloudflare:workers` import) so the node test
 * environment can exercise it against binding stubs.
 */

const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 200;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Turns a thrown `VersionError` into its status; anything else is a 500. */
export function errorResponse(error: unknown): Response {
  if (error instanceof VersionError) return json({ ok: false, error: error.message }, error.status);
  const message = error instanceof Error ? error.message : 'Request failed.';
  return json({ ok: false, error: message }, 400);
}

export function requireBindings(env: Record<string, unknown>): VersionBindings {
  const bindings = resolveBindings(env);
  if (!bindings) {
    throw new VersionError(
      'Version storage is not configured. Set the d1 and r2 bindings in .openai/hosting.json.',
      503,
    );
  }
  return bindings;
}

function readToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

/** The viewer's author id, or null when the request carries no usable token. */
export async function optionalAuthorId(request: Request): Promise<string | null> {
  const token = readToken(request);
  return token ? authorIdFor(token) : null;
}

export async function requireAuthorId(request: Request): Promise<string> {
  const token = readToken(request);
  if (!token) throw new VersionError('A publisher token is required.', 401);
  return authorIdFor(token);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new VersionError('Request body is too large.', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new VersionError('Request body is too large.', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    throw new VersionError('Request body must be JSON.', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VersionError('Request body must be a JSON object.', 400);
  }
  return parsed as Record<string, unknown>;
}
