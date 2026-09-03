import ConnectLauncher from './ConnectLauncher';

export const metadata = { title: 'Connecting · WebAlly' };

/**
 * The same-origin landing the popup opens at, before it redirects itself to the
 * provider. Opening the popup directly at a cross-origin URL is what gets the
 * window handle severed under this app's `Cross-Origin-Opener-Policy:
 * same-origin`, so the hop happens from inside the popup instead.
 *
 * Deliberately does not render `CanvasApp`: a WebContainer has no business
 * booting in a sign-in window.
 */
export default function HealthConnectPage() {
  return <ConnectLauncher />;
}
