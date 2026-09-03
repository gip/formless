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
 * So the composer asks the host whether a real client is connected and, when it
 * is not, spends the same panel explaining how to connect one instead.
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

export default function AgentComposer() {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('Ask for anything on this page.');
  const [listening, setListening] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const RecognitionCtor = useMemo(
    () => window.SpeechRecognition || window.webkitSpeechRecognition,
    [],
  );

  useEffect(() => {
    const stop = onHostEvent('mcp.status', (payload) => {
      setConnected((payload as { connected?: unknown } | undefined)?.connected === true);
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
    setNotice('Sent to the agent queue.');
    setPrompt('');
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
        setNotice('Speech captured and sent to the agent queue.');
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
        label="How to connect an agent"
        description="Explains that this page is WebMCP-enabled and that no agent is currently attached."
      >
        <aside className="agent-composer disconnected" aria-label="How to connect an agent">
          <p className="composer-headline">No agent is connected.</p>
          <p className="composer-body">
            Formless Health is WebMCP-enabled: an AI assistant can read this page, point at
            what it is talking about, and act on your behalf — but only once one is attached.
            Open this page in ChatGPT with either <strong>Terra</strong> or <strong>Sol</strong>
            {' '}to use those features.
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
      <aside className="agent-composer" aria-label="Ask the agent">
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
        <p className="composer-notice" role="status" aria-live="polite">{notice}</p>
      </aside>
    </AgentTarget>
  );
}
