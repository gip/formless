'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppVersion } from '@/lib/canvas-types';

/**
 * The version picker in the top bar. Presentational and controlled: every piece
 * of application state (the list, the current version, busy flags) lives in
 * `CanvasApp`. What is local here is disclosure and form state — whether the
 * menu is open, and what is typed into the publish fields.
 */
export interface VersionSwitcherProps {
  versions: AppVersion[];
  currentId: string | null;
  /** True when the working copy has edits the current version does not have. */
  dirty: boolean;
  busy: boolean;
  /** Non-null when the backend is unreachable or unconfigured. */
  error: string | null;
  /** `starterPackageHash()` of the running starter, for the compatibility badge. */
  starterHash: string | null;
  onSwitch: (id: string | null) => void;
  onPublish: (name: string, description: string) => void;
  onUnpublish: (id: string) => void;
}

const STARTER_LABEL = 'Starter project';

function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function VersionSwitcher(props: VersionSwitcherProps) {
  const { versions, currentId, dirty, busy, error, starterHash } = props;
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string | null; label: string } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const current = versions.find((version) => version.id === currentId) ?? null;
  const currentLabel = current?.name ?? STARTER_LABEL;

  // Closing always discards the transient panels, so the menu never reopens
  // mid-publish or mid-confirmation.
  const closeMenu = useCallback(() => {
    setOpen(false);
    setPublishing(false);
    setPendingSwitch(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenu, open]);

  function requestSwitch(id: string | null, label: string) {
    if (id === currentId) {
      closeMenu();
      return;
    }
    // Switching replaces the one working copy, so unsaved edits need a decision
    // before they are overwritten.
    if (dirty) {
      setPendingSwitch({ id, label });
      return;
    }
    props.onSwitch(id);
    closeMenu();
  }

  function submitPublish() {
    if (!name.trim()) return;
    props.onPublish(name.trim(), description.trim());
    setName('');
    setDescription('');
    closeMenu();
  }

  return (
    <div className="version-switcher" ref={rootRef}>
      <button
        type="button"
        className="version-trigger"
        onClick={() => (open ? closeMenu() : setOpen(true))}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="eyebrow">Version</span>
        <strong>{currentLabel}{dirty ? ' ·' : ''}</strong>
        {dirty && <span className="version-dirty" title="Unpublished changes">edited</span>}
        <span className="version-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="version-menu" role="menu">
          {error && <p className="version-error">{error}</p>}

          {pendingSwitch ? (
            <div className="version-confirm">
              <p>
                Your working copy has unpublished changes. Loading <strong>{pendingSwitch.label}</strong> replaces them.
              </p>
              <div className="version-confirm-actions">
                <button type="button" onClick={() => { setPendingSwitch(null); setPublishing(true); }}>
                  Publish first…
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => { props.onSwitch(pendingSwitch.id); closeMenu(); }}
                >
                  Discard and switch
                </button>
                <button type="button" onClick={() => setPendingSwitch(null)}>Cancel</button>
              </div>
            </div>
          ) : publishing ? (
            <div className="version-publish">
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  placeholder="Dark dashboard"
                  autoFocus
                />
              </label>
              <label>
                Description <span>optional</span>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={280}
                  placeholder="What makes this interface different?"
                />
              </label>
              <p className="version-note">Published versions are visible to everyone who opens WebAlly.</p>
              <div className="version-confirm-actions">
                <button type="button" className="primary" onClick={submitPublish} disabled={!name.trim() || busy}>
                  Publish
                </button>
                <button type="button" onClick={() => setPublishing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <ul className="version-list">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      role="menuitem"
                      className={version.id === currentId ? 'current' : ''}
                      onClick={() => requestSwitch(version.id, version.name)}
                      disabled={busy}
                    >
                      <span className="version-check" aria-hidden="true">{version.id === currentId ? '✓' : ''}</span>
                      <span className="version-name">
                        {version.name}
                        {version.description && <small>{version.description}</small>}
                      </span>
                      <span className="version-meta">
                        {version.mine && <em>you</em>}
                        {starterHash && version.starterHash !== starterHash && (
                          <em className="warn" title="Published against a different dependency set">older base</em>
                        )}
                        {relativeTime(version.createdAt)}
                      </span>
                    </button>
                    {version.mine && (
                      <button
                        type="button"
                        className="version-unpublish"
                        title="Unpublish this version"
                        onClick={() => props.onUnpublish(version.id)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className={currentId === null ? 'current' : ''}
                    onClick={() => requestSwitch(null, STARTER_LABEL)}
                    disabled={busy}
                  >
                    <span className="version-check" aria-hidden="true">{currentId === null ? '✓' : ''}</span>
                    <span className="version-name">{STARTER_LABEL}</span>
                    <span className="version-meta">built in</span>
                  </button>
                </li>
              </ul>
              <button type="button" className="version-publish-open" onClick={() => setPublishing(true)} disabled={busy || Boolean(error)}>
                + Publish current…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
