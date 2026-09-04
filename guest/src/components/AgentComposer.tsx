import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { AgentButton, AgentInput, AgentTarget, onHostEvent, sendUserMessage } from '../agent/bridge';

/**
 * The user's channel to the agent, docked on every route.
 *
 * `poll_user_messages` is pull-only — the page cannot push to the agent, it can
 * only queue text for the agent's next poll — so this is the *only* way a person
 * asks for something in their own words. It stays visible on both routes because
 * the moment you need it most ("what does this result mean?") is while you are
 * looking at the record, not on the landing page.
 *
 * Speech and the send button both funnel into `sendUserMessage`.
 *
 * All of which is true only when an agent is actually attached. With no MCP
 * client on the other end nothing polls the queue, so typing into the box is a
 * message to nobody — worse than no box at all, because it looks like it worked.
 * So the composer asks the host what it can see, and renders one of three
 * panels:
 *
 * - No bridge at all (`connected: false`) — the browser has no WebMCP. The
 *   panel says so and names the browsers that do, because nothing the user
 *   types here can go anywhere.
 * - A bridge, but no tool has ever been called (`active: false`) — the tools
 *   are registered and reachable, and no client has looked. The composer works,
 *   since anything queued is delivered on the first poll, but it says plainly
 *   that nobody is listening yet.
 * - A client has called a tool (`active: true`) — the ordinary composer.
 *
 * The middle state exists because bridge presence is not evidence of an agent:
 * the macOS shell injects `document.modelContext` for every frame whether or
 * not a session is attached, and an extension attaches on origin grant. The
 * protocol reports no client arriving and none leaving, so the first tool call
 * is the only honest proof — see lib/agent-activity in the host.
 *
 * The two panels with a bridge open with the starter prompt. An attached client
 * does nothing on its own — it has not read the website prompt and is not
 * polling — so the first thing a person needs is the paragraph that starts the
 * loop, in a form they can copy in one click. It is also the one thing on
 * screen that stops being useful the moment it has been used, so it carries its
 * own Done button and folds away to a single word, leaving the composer its
 * full height.
 *
 * The unsupported-browser panel omits it: there is no model on the other end to
 * paste it into, so it would be a call to action with nowhere to go.
 */

type RecognitionEvent = Event & {
  results: { length: number; [key: number]: { isFinal: boolean; 0: { transcript: string } } };
};
type RecognitionErrorEvent = Event & { error: string; message?: string };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

/**
 * How long to wait for the host's answer before assuming there is none.
 *
 * The host replies to the manifest this app posts at mount, so the answer
 * normally lands within a frame or two. A silence past this means the page is
 * not running inside the canvas at all, which is the disconnected case.
 */
const STATUS_TIMEOUT_MS = 1500;

/**
 * What the user pastes into their model to start the session.
 *
 * Written as instructions to the agent, not as prose about the agent: it is
 * read by the model, not by the person copying it. It names the tools by the
 * names WebMCP exposes (`get_website_summary`, `get_website_prompt`,
 * `poll_user_messages`, `speak_text`) so a model that has only connected — and
 * has read nothing yet — can follow it verbatim.
 */
const STARTER_PROMPT = [
  'Enable WebMCP for this page, then call get_website_summary and get_website_prompt and do what they say.',
  '',
  'Then loop: call poll_user_messages every 10 seconds, passing the id of the last message you saw as afterId. Carry out each message immediately — no clarifying questions, no confirmations, except before publishing or switching versions.',
  '',
  'When it is done, use speak_text to summarize what you did in a sentence or two, then go back to polling. Keep this page visible throughout.',
].join('\n');

/**
 * Puts text on the clipboard, by whichever route this frame allows.
 *
 * `navigator.clipboard.writeText` is the right call and the wrong one to rely
 * on alone: it is gated by the `clipboard-write` permission policy, which a
 * cross-origin frame only has if its embedder delegates it. In the canvas the
 * guest is exactly such a frame, so the promise rejects and a copy button that
 * has nothing else to try looks broken — it selects the text and stops.
 *
 * `document.execCommand('copy')` is deprecated but not permission-gated: with a
 * live user gesture and a selection it copies in the same frame where the async
 * API is refused. So try the modern API, fall back to the old one, and report
 * failure only when both are gone.
 *
 * Returns whether the text actually reached the clipboard. On failure the block
 * is left selected, which is the one thing still useful to the reader.
 */
async function copyText(text: string, block: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Refused (no delegated permission, insecure context, no async clipboard).
  }

  const selection = window.getSelection();
  if (!block || !selection) return false;
  const range = document.createRange();
  range.selectNodeContents(block);
  selection.removeAllRanges();
  selection.addRange(range);

  let copied = false;
  try {
    // Deliberately deprecated: the permission-free path. Awaiting the rejected
    // promise above kept the user gesture alive, so this still counts as one.
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  // Leave the selection in place when it is all the reader has left.
  if (copied) selection.removeAllRanges();
  return copied;
}

/**
 * The starter prompt, with the two things a person does with it: take it, and
 * be done with it.
 *
 * Collapsed, it is a single small button on the notice row — no extra height at
 * all — because the prompt is worth nothing after the first paste but the way
 * back matters on the day the agent drops the loop and has to be restarted.
 *
 * Done is deliberately not remembered across reloads. A refresh tears down the
 * page the agent was polling, so whoever comes back needs the loop started
 * again — which is this paragraph. Persisting the dismissal would hide the one
 * thing a reloaded session is missing.
 */
function StarterPrompt({
  dismissed,
  onDismiss,
  onRestore,
}: {
  dismissed: boolean;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    const block = document.getElementById('starter-prompt-text');
    // `manual` is not an error state: the text is selected and one keystroke
    // from copied. Saying which keystroke is the whole difference between that
    // and a button that looks like it failed.
    setCopyState(await copyText(STARTER_PROMPT, block) ? 'copied' : 'manual');
  }

  if (dismissed) {
    return (
      <AgentButton
        agentId="show-starter-prompt"
        agentLabel="Show the starter prompt"
        agentDescription="Reopens the prompt the user pastes into their model to start the agent loop."
        type="button"
        className="starter-reopen"
        onClick={onRestore}
      >
        Starter prompt
      </AgentButton>
    );
  }

  return (
    <div className="starter-prompt">
      <p className="composer-headline">Paste this into your model to get started</p>
      <pre id="starter-prompt-text" className="starter-prompt-text">{STARTER_PROMPT}</pre>
      <div className="starter-prompt-actions">
        <AgentButton
          agentId="copy-starter-prompt"
          agentLabel="Copy the starter prompt"
          agentDescription="Copies the starter prompt to the clipboard."
          type="button"
          className="starter-copy"
          onClick={() => { void copy(); }}
        >
          {copyState === 'copied' ? 'Copied' : 'Copy prompt'}
        </AgentButton>
        <AgentButton
          agentId="dismiss-starter-prompt"
          agentLabel="Done with the starter prompt"
          agentDescription="Hides the starter prompt to free up screen space."
          type="button"
          className="starter-done"
          onClick={onDismiss}
        >
          Done
        </AgentButton>
        {copyState === 'manual' ? (
          <p className="starter-copy-manual" role="status">
            Selected — press {navigator.platform.startsWith('Mac') ? '\u2318' : 'Ctrl'}+C to copy.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function AgentComposer() {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('Ask for anything on this page.');
  const [listening, setListening] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  /**
   * Whether a client has actually called a tool. The host can only tell us a
   * bridge exists; nothing in the protocol reports an agent arriving, and the
   * macOS shell injects its bridge whether or not a session is attached. So
   * this stays false through the state where the tools are registered and
   * nobody has ever looked, which is the state worth naming.
   */
  const [active, setActive] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const RecognitionCtor = useMemo(
    () => window.SpeechRecognition || window.webkitSpeechRecognition,
    [],
  );

  useEffect(() => {
    const stop = onHostEvent('mcp.status', (payload) => {
      const status = payload as { connected?: unknown; active?: unknown } | undefined;
      setConnected(status?.connected === true);
      // Absent from hosts older than this field, which is the same as no agent
      // having acted — so the default reads correctly rather than guessing true.
      setActive(status?.active === true);
    });
    // Nothing renders until this resolves one way or the other, so the timeout
    // is what guarantees the panel appears at all.
    const timer = window.setTimeout(() => setConnected((current) => current ?? false), STATUS_TIMEOUT_MS);
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    sendUserMessage(prompt, 'typed');
    setNotice(active
      ? 'Sent to the agent queue.'
      : 'Queued. It will be delivered when an agent picks it up.');
    setPrompt('');
  }

  function dismissStarterPrompt() {
    setPromptDismissed(true);
  }

  function restoreStarterPrompt() {
    setPromptDismissed(false);
  }

  function toggleSpeech() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    if (!RecognitionCtor) {
      setNotice('Speech recognition is unavailable in this browser. You can still type.');
      return;
    }
    const recognition = new RecognitionCtor();
    recognition.lang = navigator.language;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        if (!event.results[index].isFinal) continue;
        const transcript = event.results[index][0].transcript.trim();
        setPrompt(transcript);
        sendUserMessage(transcript, 'speech');
        setNotice(active
          ? 'Speech captured and sent to the agent queue.'
          : 'Speech captured and queued for the next agent to pick it up.');
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      setNotice('Speech recognition failed: ' + (event.error || 'unknown error') + '.');
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
    setNotice('Listening… tap again to stop.');
  }

  // Showing either panel before the host has answered would mean showing the
  // wrong one first and swapping it out under the reader.
  if (connected === null) return null;

  if (!connected) {
    return (
      <AgentTarget
        agentId="agent-composer-offline"
        label="WebMCP is not supported here"
        description="Explains that this browser exposes no WebMCP bridge, and which browsers do."
      >
        <aside className="agent-composer disconnected" aria-label="WebMCP is not supported here">
          <p className="composer-headline">This browser does not support WebMCP.</p>
          <p className="composer-body">
            Formless Health is WebMCP-enabled: an AI assistant can read this page, point at
            what it is talking about, and act on your behalf. This browser exposes no bridge
            for one to connect through. Open the page in <strong>Codex</strong> or
            {' '}<strong>Chrome</strong> to use those features.
          </p>
          <p className="composer-notice">Everything on this page works without an agent, too.</p>
        </aside>
      </AgentTarget>
    );
  }

  return (
    <AgentTarget
      agentId="agent-composer"
      label="Ask the agent"
      description="Where the user types or speaks a request for the browser agent."
    >
      <aside className={active ? 'agent-composer' : 'agent-composer idle'} aria-label="Ask the agent">
        {active ? null : (
          <p className="composer-idle" role="status">
            <strong>Agent tools are ready, but nothing has used them yet.</strong> This page
            has registered its tools with the browser; no assistant has called one so far.
            Anything you send waits here until one does.
          </p>
        )}
        {promptDismissed ? null : (
          <StarterPrompt
            dismissed={false}
            onDismiss={dismissStarterPrompt}
            onRestore={restoreStarterPrompt}
          />
        )}
        <form className="prompt-form" onSubmit={submit}>
          <AgentInput
            agentId="prompt-input"
            agentLabel="Instruction text box"
            agentDescription="Enter a message for the browser agent."
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Ask about this page…"
          />
          <AgentButton
            agentId="send-prompt"
            agentLabel="Send to agent"
            agentDescription="Queues the typed instruction for the agent."
            type="submit"
            className="composer-send"
          >
            Send <span aria-hidden="true">↗</span>
          </AgentButton>
          <AgentButton
            agentId="toggle-speech"
            agentLabel={listening ? 'Stop listening' : 'Speak'}
            agentDescription="Starts or stops speech recognition."
            type="button"
            className={listening ? 'speech active' : 'speech'}
            onClick={toggleSpeech}
          >
            <span className="mic-dot" aria-hidden="true" /> {listening ? 'Stop listening' : 'Speak'}
          </AgentButton>
        </form>
        <div className="composer-footer">
          <p className="composer-notice" role="status" aria-live="polite">{notice}</p>
          {promptDismissed ? (
            <StarterPrompt
              dismissed
              onDismiss={dismissStarterPrompt}
              onRestore={restoreStarterPrompt}
            />
          ) : null}
        </div>
      </aside>
    </AgentTarget>
  );
}
