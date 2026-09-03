import { AgentTarget } from '../agent/bridge';
import { RouteLink } from './router';
import { TERMS_EFFECTIVE, TERMS_SECTIONS, TERMS_VERSION } from './terms';

/**
 * The terms of service as a page, and as a block the acceptance dialog reuses.
 *
 * `TermsDocument` takes an id prefix because both renderings can be mounted at
 * once: the gate sits over whatever route is behind it, and `AgentTarget` throws
 * on a duplicate id. Prefixing keeps the page's sections and the dialog's copy
 * of them addressable as distinct targets rather than colliding.
 */

export function TermsDocument({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="terms-body">
      {TERMS_SECTIONS.map((section) => (
        <AgentTarget
          key={section.id}
          agentId={`${idPrefix}-section-${section.id}`}
          label={section.title}
          description={section.paragraphs[0]}
        >
          <section className="terms-section">
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </section>
        </AgentTarget>
      ))}
    </div>
  );
}

export default function TermsView() {
  return (
    <main className="terms-shell">
      <div className="terms-heading">
        <p className="eyebrow">Terms of service</p>
        <AgentTarget
          agentId="terms-page-headline"
          label="Terms headline"
          description="The title of the terms of service page."
        >
          <div>
            <h1>The terms you agreed to.</h1>
          </div>
        </AgentTarget>
        <p className="terms-meta">
          Version {TERMS_VERSION} · Effective {TERMS_EFFECTIVE}
        </p>
      </div>

      <TermsDocument idPrefix="terms-page" />

      <div className="terms-footer-actions">
        <RouteLink
          to="/"
          agentId="terms-back-home"
          agentLabel="Back to the landing page"
          agentDescription="Leaves the terms and returns to the landing page."
          className="button secondary"
        >
          Back to home
        </RouteLink>
      </div>
    </main>
  );
}
