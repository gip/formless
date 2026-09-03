'use client';

import { useEffect, useState } from 'react';

import { exchangeAuthorizationCode } from '@/lib/health/epic';
import { broadcast, readTransaction } from '@/lib/health/session';

/**
 * Where the provider returns after the user authorizes.
 *
 * This page exchanges the code for a token and broadcasts the result, then
 * stops. It deliberately does **not** run the FHIR import: that takes dozens of
 * requests over a minute or more, and this is a window the user is likely to
 * close the moment it looks finished. The host page — which stays open, owns the
 * encryption key, and can show progress — does the import instead.
 */
export default function CallbackClient() {
  const [status, setStatus] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('Completing sign-in…');

  useEffect(() => {
    let cancelled = false;

    function fail(reason: string) {
      if (cancelled) return;
      broadcast({ kind: 'error', message: reason });
      setStatus('error');
      setMessage(reason);
    }

    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const providerError = params.get('error');
      if (providerError) {
        fail(params.get('error_description') || `Your provider returned "${providerError}".`);
        return;
      }

      const code = params.get('code');
      const state = params.get('state');
      const transaction = readTransaction();

      if (!transaction) {
        fail('This sign-in could not be matched to a request from this browser.');
        return;
      }
      if (!code || !state || state !== transaction.state) {
        // A mismatched state is the CSRF check failing; never proceed past it.
        fail('The sign-in response did not match the request. Please try again.');
        return;
      }

      try {
        const token = await exchangeAuthorizationCode({
          tokenEndpoint: transaction.tokenEndpoint,
          code,
          verifier: transaction.verifier,
          clientId: transaction.clientId,
          redirectUri: transaction.redirectUri,
        });
        const patientId = token.patient?.replace(/^Patient\//, '');
        if (!token.access_token || !patientId) {
          fail('Your provider did not return a patient record for this account.');
          return;
        }
        if (cancelled) return;

        broadcast({
          kind: 'success',
          result: {
            accessToken: token.access_token,
            patientId,
            providerId: transaction.providerId,
            fhirBase: transaction.fhirBase,
          },
        });
        setStatus('done');
        setMessage('Signed in. You can close this window.');
        // Best effort: after the cross-origin hop the browser may refuse to let
        // this window close itself, so the message above has to stand on its own.
        window.setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 800);
      } catch (caught) {
        fail(caught instanceof Error ? caught.message : 'The sign-in could not be completed.');
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return (
    <main className="health-callback">
      <h1>
        {status === 'error' ? 'Sign-in failed' : status === 'done' ? 'Signed in' : 'Completing sign-in…'}
      </h1>
      <p>{message}</p>
      {status !== 'working' ? <p className="health-callback-hint">You can close this window.</p> : null}
    </main>
  );
}
