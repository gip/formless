import CallbackClient from './CallbackClient';

export const metadata = { title: 'Completing sign-in · Formless Health' };

/**
 * The registered OAuth `redirect_uri`. Like `/health/connect`, this must never
 * render `CanvasApp` — booting a WebContainer in the sign-in popup would be
 * slow, pointless, and would compete for the same origin's resources.
 */
export default function HealthCallbackPage() {
  return <CallbackClient />;
}
