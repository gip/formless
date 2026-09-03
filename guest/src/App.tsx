import { useEffect } from 'react';

import { declareRoutes } from './agent/bridge';
import AgentComposer from './components/AgentComposer';
import ExploreView from './components/ExploreView';
import HomeView from './components/HomeView';
import { useImportState } from './components/import-progress';
import TermsGate from './components/TermsGate';
import TermsView from './components/TermsView';
import { navigate, ROUTES, RouteLink, useHostNavigation, useRoute } from './components/router';

/**
 * Formless Health, running as Formless Labs' guest application.
 *
 * Three routes: the landing page and the record explorer, both ported from the
 * Next.js app, plus the terms of service. Everything an agent might rewrite
 * lives under `src/components/`; everything sensitive stays on the host and is
 * reached through the bridge.
 *
 * `TermsGate` sits over all three. Nobody connects a record before agreeing to
 * what happens to it — including that an attached agent can send parts of it to
 * OpenAI, and that a healthcare professional must not use this site at all.
 */

export default function App() {
  const route = useRoute();
  useHostNavigation();
  const importing = useImportState().active;

  useEffect(() => {
    // A download starting is a navigation event. The user authorized an import
    // in a popup and came back to a page that gave no sign anything was
    // happening; the explorer is where the progress is, and where the record
    // itself lands when it is done.
    if (importing) navigate('/explore');
  }, [importing]);

  useEffect(() => {
    // Tells the host what this app can display. `navigate_to_route` is built
    // from exactly this list, so voice control can move between pages without
    // having to find and click a link.
    declareRoutes(ROUTES, ['state', 'auth', 'record']);
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Formless Health</span>
        </div>
        <nav aria-label="Primary navigation">
          <RouteLink
            to="/"
            agentId="nav-home"
            agentLabel="Home"
            agentDescription="Goes to the landing page."
          >
            Home
          </RouteLink>
          <RouteLink
            to="/explore"
            agentId="nav-explore"
            agentLabel="Explore your record"
            agentDescription="Goes to the record explorer."
          >
            Explore
          </RouteLink>
          <RouteLink
            to="/terms"
            agentId="nav-terms"
            agentLabel="Terms"
            agentDescription="Goes to the terms of service."
          >
            Terms
          </RouteLink>
        </nav>
      </header>

      {route === '/explore' ? <ExploreView /> : null}
      {route === '/terms' ? <TermsView /> : null}
      {route === '/' ? <main><HomeView /></main> : null}

      <AgentComposer />

      <footer>
        <span>© {new Date().getFullYear()} Formless Health</span>
        <span>
          Patient-authorized. Read-only. Built for clarity. ·{' '}
          <RouteLink
            to="/terms"
            agentId="footer-terms"
            agentLabel="Terms of service"
            agentDescription="Goes to the terms of service."
          >
            Terms
          </RouteLink>
        </span>
      </footer>

      {/* Rendered last so it sits over whatever route is behind it. `showModal`
          blocks the page until the terms are accepted. */}
      <TermsGate />

      {/* The bridge writes highlight announcements here. Do not remove. */}
      <div id="agent-announcer" className="sr-only" aria-live="polite" />
    </div>
  );
}
