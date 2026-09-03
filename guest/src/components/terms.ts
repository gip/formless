/**
 * The terms of service, as data.
 *
 * One copy, two renderings: `TermsView` shows it as a page at `/terms`, and
 * `TermsGate` shows the same sections inside the acceptance dialog. A gate whose
 * summary drifts from the page it summarizes is worse than no gate, so neither
 * component owns the words.
 *
 * `TERMS_VERSION` is what acceptance is recorded against. Bump it whenever the
 * substance below changes and everyone is asked again on their next visit.
 */

export const TERMS_VERSION = '2026-09-03';
export const TERMS_EFFECTIVE = 'September 3, 2026';

/** Where acceptance lives. Host state is scoped per app version. */
export const TERMS_STATE_KEY = 'terms-acceptance';

export interface TermsAcceptance {
  version: string;
  acceptedAt: string;
}

export function isTermsAcceptance(value: unknown): value is TermsAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === 'string' && typeof record.acceptedAt === 'string';
}

export interface TermsHighlight {
  title: string;
  body: string;
}

/** The four things someone must actually understand before continuing. */
export const TERMS_HIGHLIGHTS: TermsHighlight[] = [
  {
    title: 'Personal use only',
    body:
      'Formless Health is for reading your own health record. Do not use it on behalf of a '
    + 'patient, and do not use it as a healthcare professional — this is not a clinical system, '
    + 'and no business associate agreement covers it.',
  },
  {
    title: 'No health data reaches our server',
    body:
      'Your browser talks to your provider’s Epic system directly. The record is encrypted on '
    + 'this device with a passphrase you choose, and the key never leaves the page. There is no '
    + 'route on our server that receives it.',
  },
  {
    title: 'An AI agent sees what you show it',
    body:
      'This page is built to be driven by an AI agent in ChatGPT. While one is attached, parts '
    + 'of your health record are sent to OpenAI’s models and handled under OpenAI’s terms, not '
    + 'ours. With no agent attached, nothing goes to OpenAI.',
  },
  {
    title: 'Not medical advice',
    body:
      'The export organizes the records your provider released, and an agent reading them can be '
    + 'wrong. Nothing here diagnoses, prescribes, or replaces your care team.',
  },
];

export interface TermsSection {
  id: string;
  title: string;
  paragraphs: string[];
}

export const TERMS_SECTIONS: TermsSection[] = [
  {
    id: 'who',
    title: '1. Who may use Formless Health',
    paragraphs: [
      'Formless Health is a personal tool. You may use it to import, read, and keep a copy of a '
      + 'health record that is your own, or one you are the legally authorized representative for. '
      + 'That is the only permitted use.',
      'You may not use it to look at another person’s record, to provide a service to anyone else, '
      + 'or for any professional, clinical, research, billing, employment, insurance, or commercial '
      + 'purpose. You must be old enough to hold your own MyChart account with your provider.',
      'You are responsible for the authorization you grant at your provider. Connecting a record '
      + 'means telling your healthcare organization to release it to this browser, and only you can '
      + 'make that decision.',
    ],
  },
  {
    id: 'professionals',
    title: '2. Healthcare professionals must not use this site',
    paragraphs: [
      'If you are a clinician, care-team member, or anyone else acting in a professional capacity, '
      + 'do not use Formless Health for that work. It is not a certified electronic health record, '
      + 'not a medical device, and not a HIPAA-compliant system for a covered entity or a business '
      + 'associate. We do not offer or sign a business associate agreement.',
      'Do not use this site to view, discuss, store, or move a patient’s information — including '
      + 'your own patients, and including records you have lawful access to at work. Using it that '
      + 'way is a breach of these terms and may be a breach of your own obligations.',
    ],
  },
  {
    id: 'data-flow',
    title: '3. Where your data goes',
    paragraphs: [
      'Three parties touch your health record, and our server is not one of them: your provider’s '
      + 'Epic system, this browser, and — only if you attach one — an AI agent.',
      'Sign-in happens on your healthcare organization’s MyChart site. We never see your MyChart '
      + 'password. Your browser then requests the record from Epic’s API directly, using the '
      + 'read-only authorization you granted, and it is the only thing that receives the data.',
      'Before anything is stored, the record is encrypted in this browser with a passphrase you '
      + 'choose (Argon2id key derivation, AES-GCM at rest). The encryption key exists only in this '
      + 'page’s memory. Lose the passphrase and the stored copy cannot be recovered — by you or by '
      + 'us.',
      'No personal health information is transmitted to, processed by, or stored on our server. '
      + 'The server delivers the application, stores app versions people publish, and keeps a '
      + 'digest of the publisher token your browser mints. It has no endpoint that accepts a health '
      + 'record, and it never holds your passphrase or your Epic access token.',
    ],
  },
  {
    id: 'agent',
    title: '4. The AI agent, and what OpenAI receives',
    paragraphs: [
      'Formless Health is WebMCP-enabled: an AI agent running in ChatGPT can read this page, point '
      + 'at what it is describing, and call the tools this site exposes — including tools that read '
      + 'the record you imported.',
      'That is the point of the site, and it has a consequence you should decide about knowingly: '
      + 'while an agent is attached, personal health information from your record can be sent to '
      + 'OpenAI and processed by OpenAI’s models. What happens to it there — retention, human '
      + 'review, training — is governed by OpenAI’s terms and privacy policy and by your own '
      + 'ChatGPT settings, not by us. We do not control it and cannot retract it for you.',
      'By accepting these terms you acknowledge and consent to that sharing. It is not silent and '
      + 'it is not required: the site works fully without an agent, and when none is attached '
      + 'nothing about your record is sent to OpenAI. The composer at the bottom of the page tells '
      + 'you which of the two situations you are in.',
    ],
  },
  {
    id: 'not-advice',
    title: '5. Not medical advice',
    paragraphs: [
      'Formless Health organizes documents your provider released. It does not diagnose, treat, '
      + 'prescribe, or interpret your care, and it is not a substitute for your clinician.',
      'An agent summarizing a record can be confidently wrong: it can misread a value, miss a '
      + 'result, or invent context. Verify anything that matters against the source record and your '
      + 'care team before acting on it. In an emergency, call your local emergency number rather '
      + 'than asking a chatbot.',
    ],
  },
  {
    id: 'your-copy',
    title: '6. Your copy is yours to protect',
    paragraphs: [
      'The imported record lives in this browser, on this device. Anyone who can use this device '
      + 'and knows your passphrase can read it, and anything you download leaves our protection '
      + 'entirely. Screen sharing, shared computers, and a browser profile someone else uses are '
      + 'all ways a record leaks without anyone attacking anything.',
      '“Disconnect” removes the stored record from this browser. Removing it here does not revoke '
      + 'the authorization you granted at your provider — do that in your MyChart account settings.',
    ],
  },
  {
    id: 'versions',
    title: '7. Publishing app versions',
    paragraphs: [
      'This site lets you (or an agent working for you) rewrite its interface and publish the '
      + 'result as a named version. Everything you publish is public: anyone who opens Formless '
      + 'Health can list it, run it, and read its source. Never put health information, notes about '
      + 'your care, or anything else private into code you publish.',
      'A version published by someone else is a stranger’s code. It runs sandboxed and is refused '
      + 'access to your record unless you explicitly allow it, and you accept these terms again '
      + 'inside it. Choosing to trust such a version is your decision and your risk.',
      'Do not publish code that is unlawful, that attempts to exfiltrate another person’s data, or '
      + 'that impersonates a healthcare provider. We may remove any published version at any time.',
    ],
  },
  {
    id: 'warranty',
    title: '8. No warranty, and limits on liability',
    paragraphs: [
      'Formless Health is provided as is, without warranty of any kind. We do not promise that an '
      + 'import will be complete, that your provider’s data is accurate, that the service will be '
      + 'available, or that a stored record will survive a browser that clears its storage. Keep '
      + 'your own backup of anything you need.',
      'To the fullest extent the law allows, we are not liable for any indirect, incidental, or '
      + 'consequential damages arising from your use of the service, including any decision made on '
      + 'the basis of what the site or an agent showed you.',
      'We may suspend or discontinue the service at any time. You may stop using it at any time; '
      + 'disconnecting and clearing your browser storage removes what it kept.',
    ],
  },
  {
    id: 'changes',
    title: '9. Changes to these terms',
    paragraphs: [
      'When these terms change in substance, the version below changes with them and you are asked '
      + 'to accept the new text before continuing. Acceptance is recorded per app version, so a '
      + 'different published interface asks you again rather than inheriting a decision you made '
      + 'about this one.',
      `This is version ${TERMS_VERSION}, effective ${TERMS_EFFECTIVE}.`,
    ],
  },
];
