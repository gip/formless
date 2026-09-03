import {
  errorResponse,
  json,
  optionalAuthorId,
  readJsonBody,
  requireAuthorId,
  requireBindings,
} from '@/lib/version-request';
import { getVersion, hideVersion, updateVersion, VersionError } from '@/lib/version-store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function versionId(value: string): string {
  if (!/^[0-9a-f]{16}$/.test(value)) throw new VersionError('Unknown version.', 404);
  return value;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const bindings = requireBindings(process.env);
    const { id } = await context.params;
    const viewerId = await optionalAuthorId(request);
    const version = await getVersion(bindings, versionId(id), viewerId);
    if (!version) return json({ ok: false, error: 'Unknown version.' }, 404);
    return json({ ok: true, version });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const bindings = requireBindings(process.env);
    const { id } = await context.params;
    const authorId = await requireAuthorId(request);
    const body = await readJsonBody(request);
    const version = await updateVersion(bindings, versionId(id), authorId, {
      name: body.name,
      description: body.description,
    });
    return json({ ok: true, version });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  try {
    const bindings = requireBindings(process.env);
    const { id } = await context.params;
    const authorId = await requireAuthorId(request);
    await hideVersion(bindings, versionId(id), authorId);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
