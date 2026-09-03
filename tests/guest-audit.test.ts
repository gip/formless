import { describe, expect, it } from 'vitest';

import { STARTER_FILES } from '../lib/starter-project';

/**
 * The guest runs `scripts/audit-ui.mjs` inside the WebContainer, but only as
 * part of `npm run validate` on an agent write — a 45s round trip that a human
 * editing `guest/` by hand never triggers. Now that the guest is real files
 * rather than template literals, the same rules are cheap to enforce here, so a
 * raw `<button>` fails `pnpm test` in milliseconds instead of surfacing as a
 * rolled-back agent change later.
 *
 * Keep these checks in step with `guest/scripts/audit-ui.mjs`.
 */

const RAW_INTERACTIVE = /<(button|input|textarea|select|a)(\s|>)/;
const AGENT_ID = /agentId=["']([^"']+)["']/g;

function guestComponentFiles(): [string, string][] {
  return Object.entries(STARTER_FILES).filter(
    ([path]) => path.startsWith('src/') && /\.(tsx|jsx)$/.test(path) && !path.includes('/agent/'),
  );
}

describe('guest instrumentation audit', () => {
  it('has guest component files to audit', () => {
    expect(guestComponentFiles().length).toBeGreaterThan(0);
  });

  it('uses no raw interactive JSX elements outside src/agent', () => {
    const offenders = guestComponentFiles()
      .filter(([, source]) => RAW_INTERACTIVE.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('declares no duplicate literal agentId', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [path, source] of guestComponentFiles()) {
      for (const match of source.matchAll(AGENT_ID)) {
        const prior = seen.get(match[1]);
        if (prior) duplicates.push(`${match[1]} in ${path} and ${prior}`);
        else seen.set(match[1], path);
      }
    }
    expect(duplicates).toEqual([]);
  });
});

describe('guest structural invariants', () => {
  it('keeps the entry points src/main.tsx imports', () => {
    // `src/main.tsx` is protected and hard-imports both of these paths.
    expect(STARTER_FILES['src/App.tsx']).toBeTypeOf('string');
    expect(STARTER_FILES['src/styles/app.css']).toBeTypeOf('string');
  });

  it('keeps the live region the bridge announces highlights into', () => {
    const app = Object.entries(STARTER_FILES)
      .filter(([path]) => path.startsWith('src/') && path.endsWith('.tsx'))
      .map(([, source]) => source)
      .join('\n');
    expect(app).toContain('id="agent-announcer"');
  });

  it('keeps a user-message sender wired, or poll_user_messages is dead', () => {
    const components = guestComponentFiles().map(([, source]) => source).join('\n');
    expect(components).toContain('sendUserMessage');
  });

  it('mounts no file outside the WebContainer allowlist', () => {
    const unexpected = Object.keys(STARTER_FILES).filter(
      (path) => !/\.(ts|tsx|css|json|html|mjs)$/.test(path),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('guest provider list', () => {
  /**
   * The guest cannot import host code, so `guest/src/components/health-types.ts`
   * keeps its own copy of the provider list. A copy that drifts is worse than no
   * copy: the connect button would offer to sign you in to an organization by
   * the wrong name. This pins it to `lib/health/providers.ts`.
   */
  it('matches the host registry it copies', async () => {
    const { PROVIDERS } = await import('../lib/health/providers');
    const guest = STARTER_FILES['src/components/health-types.ts'] ?? '';

    for (const provider of Object.values(PROVIDERS)) {
      expect(guest).toContain(`id: '${provider.id}'`);
      expect(guest).toContain(`myChartName: '${provider.myChartName}'`);
      expect(guest).toContain(`label: '${provider.name}'`);
    }

    // And no provider the host does not know about.
    const declared = [...guest.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual(Object.keys(PROVIDERS).sort());
  });
});
