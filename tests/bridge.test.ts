import { describe, expect, it } from 'vitest';
import { isBridgeEnvelope, isTrustedPreviewMessage } from '../lib/bridge';
import { BRIDGE_PROTOCOL } from '../lib/canvas-types';

describe('preview bridge validation', () => {
  it('requires protocol, source window, and exact origin', () => {
    const frame = {} as Window;
    const valid = { source: frame, origin: 'https://preview.example', data: { protocol: BRIDGE_PROTOCOL, type: 'registry' } };
    expect(isBridgeEnvelope(valid.data)).toBe(true);
    expect(isTrustedPreviewMessage(valid, frame, 'https://preview.example')).toBe(true);
    expect(isTrustedPreviewMessage({ ...valid, origin: 'https://evil.example' }, frame, 'https://preview.example')).toBe(false);
    expect(isTrustedPreviewMessage({ ...valid, source: {} as Window }, frame, 'https://preview.example')).toBe(false);
  });
});

