import { BRIDGE_PROTOCOL } from './canvas-types';

export interface BridgeEnvelope {
  protocol: typeof BRIDGE_PROTOCOL;
  type: string;
  payload?: unknown;
}

export function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.protocol === BRIDGE_PROTOCOL && typeof record.type === 'string';
}

export function isTrustedPreviewMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frameWindow: Window | null,
  previewOrigin: string | null,
): event is Pick<MessageEvent, 'source' | 'origin' | 'data'> & { data: BridgeEnvelope } {
  return Boolean(
    frameWindow &&
      previewOrigin &&
      event.source === frameWindow &&
      event.origin === previewOrigin &&
      isBridgeEnvelope(event.data),
  );
}

