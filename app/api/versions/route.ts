import { env } from 'cloudflare:workers';
import {
  errorResponse,
  json,
  optionalAuthorId,
  readJsonBody,
  requireAuthorId,
  requireBindings,
} from '@/lib/version-request';
import { listVersions, publishVersion } from '@/lib/version-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const bindings = requireBindings(env as unknown as Record<string, unknown>);
    const viewerId = await optionalAuthorId(request);
    return json({ ok: true, versions: await listVersions(bindings, viewerId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const bindings = requireBindings(env as unknown as Record<string, unknown>);
    const authorId = await requireAuthorId(request);
    const body = await readJsonBody(request);
    const version = await publishVersion(bindings, {
      authorId,
      name: body.name,
      description: body.description,
      starterHash: body.starterHash,
      files: body.files,
    });
    return json({ ok: true, version }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
