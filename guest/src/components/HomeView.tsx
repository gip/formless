import { AgentLink, AgentTarget } from '../agent/bridge';
import ConnectPanel from './ConnectPanel';
import { RouteLink } from './router';

/**
 * The landing page, ported from yesyouhealth's `app/page.tsx`.
 *
 * That route was an async server component reading a next-auth session and the
 * Epic client id from server env. Neither exists here, so the role branching is
 * gone and the connect control asks the host instead. The copy and structure are
 * otherwise unchanged.
 */

const STEPS = [
  { n: '1', title: 'Sign in at MyChart', note: 'Your password stays with your provider.' },
  { n: '2', title: 'Approve read-only access', note: 'You decide whether to share.' },
  { n: '3', title: 'Encrypt and explore', note: 'Create a passphrase before anything is stored.' },
];

const TRUST = [
  {
    n: '01',
    title: 'No password collection',
    body: "Authentication happens directly on the healthcare organization's MyChart website.",
  },
  {
    n: '02',
    title: 'Encrypted local storage',
    body: 'Your browser encrypts the authorized record with your passphrase before storing it. Health data does not pass through our server.',
  },
  {
    n: '03',
    title: 'Not a clinical judgment',
    body: 'The export organizes source records; it does not diagnose, prescribe, or replace your care team.',
  },
];

export default function HomeView() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Your care, made understandable</p>
          <AgentTarget
            agentId="home-headline"
            label="Page headline"
            description="The main promise of the service."
          >
            <div>
              <h1>See what happened in your care—and keep the record.</h1>
            </div>
          </AgentTarget>
          <AgentTarget
            agentId="home-lede"
            label="Service explanation"
            description="Explains what the service does with the patient's health data and what choices they will have."
          >
            <p className="lede">
              Formless Health helps patients understand the actions taken and documented as part of their care.
              Connect MyChart, authorize read-only access, and receive a private export of the health data
              made available by your provider, encrypted on your device with a passphrase you choose.
              As the platform grows, patients will also be able to choose whether to contribute a
              de-identified copy of their data to a shared dataset, whether it may be used to train
              an IBD action model, and—later—whether their feedback may help improve that model
              through reinforcement learning. These choices will be optional and separate from
              accessing or keeping their own record.
            </p>
          </AgentTarget>

          <ConnectPanel />

          <p className="consent-note">
            By continuing, you agree to the{' '}
            <RouteLink
              to="/terms"
              agentId="home-terms-link"
              agentLabel="Terms"
              agentDescription="Opens the terms of service."
            >
              Terms
            </RouteLink>{' '}
            and acknowledge the{' '}
            <AgentLink
              agentId="home-privacy-link"
              agentLabel="Privacy Notice"
              agentDescription="Opens the privacy notice. Not part of this build."
              href="#/"
              onClick={(event: React.MouseEvent) => event.preventDefault()}
            >
              Privacy Notice
            </AgentLink>
            .
          </p>
        </div>

        <AgentTarget
          agentId="home-record-card"
          label="How the export works"
          description="Three steps describing the MyChart authorization and export flow."
        >
          <aside className="record-card" aria-label="How the export works">
            <div className="record-card-top">
              <span className="status-dot" />
              <span>Patient-authorized export</span>
            </div>
            <ol className="steps">
              {STEPS.map((step) => (
                <li key={step.n}>
                  <span>{step.n}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.note}</small>
                  </div>
                </li>
              ))}
            </ol>
            <RouteLink
              to="/explore"
              agentId="home-open-explorer"
              agentLabel="Open the record explorer"
              agentDescription="Goes to the record explorer, which shows a sample record when none has been imported."
              className="button secondary record-card-cta"
            >
              Open the record explorer
            </RouteLink>
          </aside>
        </AgentTarget>
      </section>

      <section className="trust-grid" aria-label="Privacy highlights">
        {TRUST.map((item) => (
          <AgentTarget
            key={item.n}
            agentId={`home-trust-${item.n}`}
            label={item.title}
            description={item.body}
          >
            <article>
              <span>{item.n}</span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </article>
          </AgentTarget>
        ))}
      </section>
    </>
  );
}
