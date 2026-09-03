import { useMemo, useRef, useState, type FormEvent } from 'react';

import { AgentButton, AgentInput, AgentTarget, sendUserMessage } from '../agent/bridge';

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

export default function AgentComposer() {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('Ask for anything on this page.');
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const RecognitionCtor = useMemo(
    () => window.SpeechRecognition || window.webkitSpeechRecognition,
    [],
  );

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
