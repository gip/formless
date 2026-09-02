'use client';

import type { ProjectController } from './project-controller';
import type { AppVersion, ToolDefinition, UiElementDescriptor } from './canvas-types';
import type { UserMessageQueue } from './message-queue';

/**
 * Published-version operations, implemented by `CanvasApp` so the header and
 * the WebMCP tools drive exactly the same code path.
 */
export interface VersionOperations {
  list: () => Promise<AppVersion[]>;
  publish: (input: { name: string; description?: string }) => Promise<AppVersion>;
  switchTo: (baseRevision: number, versionId: string) => Promise<{ revision: number; version: AppVersion }>;
  current: () => { id: string | null; name: string; dirty: boolean };
}

interface ToolEnvironment {
  project: ProjectController;
  messages: UserMessageQueue;
  getElements: () => UiElementDescriptor[];
  sendPreviewCommand: (type: 'highlight' | 'clear-highlight', payload?: Record<string, unknown>) => void;
  versions: VersionOperations;
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

function tool(
  name: string,
  title: string,
  description: string,
  readOnlyHint: boolean,
  inputSchema: Record<string, unknown>,
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint, untrustedContentHint: false },
    execute: async (input) => {
      try {
        return await execute(input ?? {});
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Tool execution failed.' };
      }
    },
  };
}

export function createCanvasTools(environment: ToolEnvironment): ToolDefinition[] {
  return [
    tool(
      'get_website_summary',
      'Get website summary',
      'Call this first when you connect to the website. Explains what WebAlly is and how to use its tools.',
      true,
      emptySchema,
      async () => ({
        ok: true,
        website: {
          name: 'WebAlly',
          summary: 'WebAlly is an agent-ready interface lab. It runs an editable React application inside a live WebContainer preview and exposes project, UI, and user-message controls through WebMCP.',
        },
        startupInstructions: [
          'Inspect the project with list_project_files, then read only the files you need with read_project_files.',
          'Inspect the live preview with get_ui_elements. Use highlight_ui_elements to direct the user\'s attention, and clear_ui_highlights when the emphasis is no longer useful.',
          'Apply requested code edits with apply_project_changes using the latest project revision and complete file contents. Changes are limited to editable app files, validated atomically, and rolled back if validation fails.',
          'Call reset_project only when the user explicitly asks to restore the starter project.',
          'When the user is happy with an interface, offer to publish it with publish_app_version so other visitors can load it. Use list_app_versions to see what already exists and switch_app_version to load one. Both publishing and switching are public or destructive, so confirm with the user first.',
          'While waiting for typed or spoken requests, call poll_user_messages about every two seconds with the last message ID as afterId.',
        ],
      }),
    ),
    tool(
      'get_website_prompt',
      'Get website prompt',
      'Returns the prompt that governs how the agent should work with this website.',
      true,
      emptySchema,
      async () => ({
        ok: true,
        prompt: 'Follow the user\'s instructions. Keep the WebAlly browser visible to the user at all times.',
      }),
    ),
    tool('list_project_files', 'List project files', 'Lists source files in the live WebContainer project with revision, editability, size, and hash.', true, emptySchema, async () => ({ ok: true, ...await environment.project.listFiles() })),
    tool(
      'read_project_files',
      'Read project files',
      'Reads one to twenty UTF-8 source files from the live project. Use list_project_files first.',
      true,
      {
        type: 'object',
        properties: {
          paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
          revision: { type: 'integer', minimum: 0 },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      async ({ paths, revision }) => ({ ok: true, ...await environment.project.readFiles(paths, revision) }),
    ),
    tool(
      'apply_project_changes',
      'Apply project changes',
      'Atomically writes or deletes editable application files, validates the project, and rolls back failures. Full file contents are required for writes.',
      false,
      {
        type: 'object',
        properties: {
          baseRevision: { type: 'integer', minimum: 0 },
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                operation: { type: 'string', enum: ['write', 'delete'] },
                content: { type: 'string' },
              },
              required: ['path', 'operation'],
              additionalProperties: false,
            },
          },
        },
        required: ['baseRevision', 'changes'],
        additionalProperties: false,
      },
      async ({ baseRevision, changes }) => environment.project.applyChanges(baseRevision, changes),
    ),
    tool(
      'reset_project',
      'Reset project',
      'Restores the editable app to the starter snapshot. Call only after the user explicitly requests a reset.',
      false,
      {
        type: 'object',
        properties: {
          baseRevision: { type: 'integer', minimum: 0 },
          confirm: { type: 'boolean', const: true },
        },
        required: ['baseRevision', 'confirm'],
        additionalProperties: false,
      },
      async ({ baseRevision, confirm }) => environment.project.reset(baseRevision, confirm),
    ),
    tool('get_ui_elements', 'Get UI elements', 'Returns the stable IDs and current state of instrumented elements in the live preview.', true, emptySchema, async () => ({ ok: true, generation: Date.now(), elements: environment.getElements() })),
    tool(
      'highlight_ui_elements',
      'Highlight UI elements',
      'Highlights one or more live UI elements, optionally blinks between two colors, and dims or hides everything else in the preview. Set durationSeconds to clear the highlight automatically.',
      false,
      {
        type: 'object',
        properties: {
          elementIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
          alternateColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
          blinkIntervalMs: { type: 'number', minimum: 100, maximum: 5000 },
          durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 300 },
          restTreatment: { type: 'string', enum: ['dim', 'hide'] },
          dimOpacity: { type: 'number', minimum: 0.1, maximum: 0.8 },
        },
        required: ['elementIds', 'color', 'restTreatment'],
        additionalProperties: false,
      },
      async ({ elementIds, color, alternateColor, blinkIntervalMs, durationSeconds, restTreatment, dimOpacity }) => {
        if (!Array.isArray(elementIds) || elementIds.length === 0 || !elementIds.every((id) => typeof id === 'string')) throw new Error('elementIds must be a non-empty string array.');
        if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('color must be a six-digit hex color.');
        if (alternateColor !== undefined && (typeof alternateColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(alternateColor))) throw new Error('alternateColor must be a six-digit hex color.');
        if (blinkIntervalMs !== undefined && (typeof blinkIntervalMs !== 'number' || blinkIntervalMs < 100 || blinkIntervalMs > 5000)) throw new Error('blinkIntervalMs must be between 100 and 5000 milliseconds.');
        if (durationSeconds !== undefined && (typeof durationSeconds !== 'number' || durationSeconds <= 0 || durationSeconds > 300)) throw new Error('durationSeconds must be greater than 0 and no more than 300 seconds.');
        if (restTreatment !== 'dim' && restTreatment !== 'hide') throw new Error('restTreatment must be dim or hide.');
        const available = new Set(environment.getElements().map((element) => element.id));
        const unknown = elementIds.filter((id) => !available.has(id));
        if (unknown.length) throw new Error(`Unknown UI element IDs: ${unknown.join(', ')}`);
        environment.sendPreviewCommand('highlight', {
          elementIds,
          color: color.toUpperCase(),
          alternateColor: typeof alternateColor === 'string' ? alternateColor.toUpperCase() : undefined,
          blinkIntervalMs: typeof alternateColor === 'string' ? (typeof blinkIntervalMs === 'number' ? blinkIntervalMs : 500) : undefined,
          durationSeconds,
          restTreatment,
          dimOpacity: typeof dimOpacity === 'number' ? Math.min(0.8, Math.max(0.1, dimOpacity)) : 0.24,
        });
        return {
          ok: true,
          highlighted: elementIds,
          color: color.toUpperCase(),
          alternateColor: typeof alternateColor === 'string' ? alternateColor.toUpperCase() : null,
          blinkIntervalMs: typeof alternateColor === 'string' ? (typeof blinkIntervalMs === 'number' ? blinkIntervalMs : 500) : null,
          durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : null,
          restTreatment,
        };
      },
    ),
    tool('clear_ui_highlights', 'Clear UI highlights', 'Restores every registered UI element to its normal visual state.', false, emptySchema, async () => {
      environment.sendPreviewCommand('clear-highlight');
      return { ok: true };
    }),
    tool(
      'poll_user_messages',
      'Poll user messages',
      'Returns typed and final speech messages after a monotonic cursor. Poll approximately every two seconds while listening for user input.',
      true,
      {
        type: 'object',
        properties: { afterId: { type: 'integer', minimum: 0, default: 0 } },
        additionalProperties: false,
      },
      async ({ afterId }) => ({ ok: true, ...environment.messages.poll(typeof afterId === 'number' ? afterId : 0) }),
    ),
    tool(
      'list_app_versions',
      'List app versions',
      'Lists the published versions of this app that anyone can switch to, and reports which one the live preview is currently showing.',
      true,
      emptySchema,
      async () => ({ ok: true, current: environment.versions.current(), versions: await environment.versions.list() }),
    ),
    tool(
      'publish_app_version',
      'Publish app version',
      'Publishes the current editable app as a named version that every visitor can see and load. Publishing is public and permanent until you unpublish it, so ask the user before calling this.',
      false,
      {
        type: 'object',
        properties: {
          baseRevision: { type: 'integer', minimum: 0 },
          name: { type: 'string', minLength: 1, maxLength: 60 },
          description: { type: 'string', maxLength: 280 },
          confirm: { type: 'boolean', const: true },
        },
        required: ['baseRevision', 'name', 'confirm'],
        additionalProperties: false,
      },
      async ({ baseRevision, name, description, confirm }) => {
        if (confirm !== true) throw new Error('Publishing requires confirm: true.');
        if (typeof name !== 'string' || !name.trim()) throw new Error('A version name is required.');
        if (description !== undefined && typeof description !== 'string') throw new Error('description must be a string.');
        // Guard the revision here as well as in the store: publishing the wrong
        // revision is not rolled back once it is public.
        const { revision } = await environment.project.listFiles();
        if (baseRevision !== revision) throw new Error(`Revision conflict. Current revision is ${revision}.`);
        return { ok: true, version: await environment.versions.publish({ name, description }) };
      },
    ),
    tool(
      'switch_app_version',
      'Switch app version',
      'Replaces the live preview with a published version. The current working copy is overwritten, so confirm with the user first — publish their unsaved work before switching if they want to keep it.',
      false,
      {
        type: 'object',
        properties: {
          baseRevision: { type: 'integer', minimum: 0 },
          versionId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
          confirm: { type: 'boolean', const: true },
        },
        required: ['baseRevision', 'versionId', 'confirm'],
        additionalProperties: false,
      },
      async ({ baseRevision, versionId, confirm }) => {
        if (confirm !== true) throw new Error('Switching versions requires confirm: true.');
        if (typeof versionId !== 'string' || !/^[0-9a-f]{16}$/.test(versionId)) throw new Error('versionId must be a published version id.');
        if (typeof baseRevision !== 'number') throw new Error('baseRevision is required.');
        const { revision, version } = await environment.versions.switchTo(baseRevision, versionId);
        return { ok: true, revision, version };
      },
    ),
  ];
}

export function registerNativeTools(tools: ToolDefinition[]): { native: boolean; dispose: () => void } {
  const modelContext = document.modelContext;
  if (!modelContext) return { native: false, dispose: () => undefined };

  const controllers = tools.map(() => new AbortController());
  tools.forEach((definition, index) => {
    Promise.resolve(modelContext.registerTool(definition, { signal: controllers[index].signal })).catch((error) => {
      if (!controllers[index].signal.aborted) console.warn(`Failed to register WebMCP tool ${definition.name}`, error);
    });
  });
  return {
    native: true,
    dispose: () => controllers.forEach((controller) => controller.abort()),
  };
}
