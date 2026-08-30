'use client';

import type { ProjectController } from './project-controller';
import type { ToolDefinition, UiElementDescriptor } from './canvas-types';
import type { UserMessageQueue } from './message-queue';

interface ToolEnvironment {
  project: ProjectController;
  messages: UserMessageQueue;
  getElements: () => UiElementDescriptor[];
  sendPreviewCommand: (type: 'highlight' | 'clear-highlight', payload?: Record<string, unknown>) => void;
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
