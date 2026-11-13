import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { IMPORT_MAX_BYTES } from "../shared/limits.ts";
import type { Health, ImportResult, MemoryChip } from "../shared/types.ts";
import { ApiFailure, api, streamChat } from "./http/client.ts";
import styles from "./App.module.css";
import { Banner } from "./components/Banner.tsx";
import { Composer } from "./components/Composer.tsx";
import { Header } from "./components/Header.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { RecordsPanel, type ViewedRecord } from "./components/RecordsPanel.tsx";
import { WelcomeCard } from "./components/WelcomeCard.tsx";
import { browserTimezone } from "./format.ts";
import { chatReducer, initialChat, isStreaming, makeKey, type ChatState } from "./state/chat.ts";
import { initialRecords, recordsReducer } from "./state/records.ts";

const THREAD_KEY = "minimi-agent.thread";
const TOO_LARGE = `This file is over ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it and upload the parts.`;
/** How close to the bottom still counts as "at the bottom" for auto-scroll. */
const BOTTOM_SLACK_PX = 48;

// localStorage can throw (private mode, blocked storage); the app works without it.
function storedThread(): string | null {
  try {
    return localStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
}

function storeThread(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(THREAD_KEY);
    else localStorage.setItem(THREAD_KEY, id);
  } catch {
    // Without storage, a reload starts a new chat; nothing else is lost.
  }
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiFailure ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function App() {
  const [timezone] = useState(browserTimezone);
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [chat, dispatchChat] = useReducer(chatReducer, null, (): ChatState => initialChat(storedThread() ?? crypto.randomUUID()));
  const [records, dispatchRecords] = useReducer(recordsReducer, initialRecords);
  const [restoring, setRestoring] = useState(() => storedThread() !== null);
  const [startedWithout, setStartedWithout] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [viewing, setViewing] = useState<ViewedRecord | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const stream = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const recordsButton = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const followStream = useRef(true);

  const streaming = isStreaming(chat);

  const loadRecords = useCallback(async () => {
    dispatchRecords({ type: "load_start" });
    try {
      dispatchRecords({ type: "loaded", records: await api.records() });
    } catch (error) {
      dispatchRecords({ type: "load_failed", message: failureMessage(error, "Your records can't be read right now.") });
    }
  }, []);

  // First load: which keys are set, the records, and the chat open before a reload.
  useEffect(() => {
    api.health().then(setHealth, (error: unknown) => setServerDown(failureMessage(error, "The server can't be reached.")));
    void loadRecords();

    const saved = storedThread();
    if (saved === null) return;
    api.thread(saved).then(
      (messages) => {
        dispatchChat({ type: "restored", threadId: saved, messages });
        setRestoring(false);
      },
      (error: unknown) => {
        // The chat was removed (or never saved): start a fresh one.
        if (error instanceof ApiFailure && error.status === 404) storeThread(null);
        dispatchChat({ type: "new_thread", threadId: crypto.randomUUID() });
        setRestoring(false);
      },
    );
  }, [loadRecords]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Auto-scroll follows the stream only while the user is at the bottom (U8).
  useEffect(() => {
    const onScroll = () => {
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK_PX;
      followStream.current = bottom;
      setAtBottom(bottom);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (followStream.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [chat.messages]);

  const jumpToLatest = () => {
    followStream.current = true;
    setAtBottom(true);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  };

  const ask = async (question: string, retryKey?: string) => {
    if (streaming) return;
    const answerKey = retryKey ?? makeKey();
    if (retryKey === undefined) dispatchChat({ type: "asked", userKey: makeKey(), answerKey, question });
    else dispatchChat({ type: "retried", answerKey });
    storeThread(chat.threadId);
    followStream.current = true;
    setAtBottom(true);

    const controller = new AbortController();
    stream.current = controller;
    try {
      const finished = await streamChat({ threadId: chat.threadId, message: question, timezone }, controller.signal, (event) => {
        dispatchChat({ type: "event", answerKey, event });
        if (event.type === "done") setSaveFailed(event.messageId === null);
      });
      if (!finished) dispatchChat({ type: "ended", answerKey, how: "cut" });
    } catch (error) {
      if (isAbort(error)) dispatchChat({ type: "ended", answerKey, how: "stopped" });
      else {
        dispatchChat({
          type: "ended",
          answerKey,
          how: "failed",
          message: failureMessage(error, "The answer didn't come through. Your message is saved."),
        });
      }
    } finally {
      stream.current = null;
      // The chat is a record too, so the list and its count change.
      void loadRecords();
      composer.current?.focus();
    }
  };

  const stop = () => stream.current?.abort();

  const newChat = () => {
    stream.current?.abort();
    storeThread(null);
    setSaveFailed(false);
    dispatchChat({ type: "new_thread", threadId: crypto.randomUUID() });
    composer.current?.focus();
  };

  const runImport = async (load: () => Promise<ImportResult>) => {
    dispatchRecords({ type: "import_start" });
    try {
      dispatchRecords({ type: "imported", result: await load() });
      await loadRecords();
    } catch (error) {
      dispatchRecords({
        type: "import_failed",
        message: failureMessage(error, "The records couldn't be loaded. Nothing was imported."),
        details: error instanceof ApiFailure ? error.details : [],
      });
    }
  };

  const loadSample = () => runImport(() => api.importSample(timezone));

  const upload = (file: File) => {
    // Checked here too, so a huge file fails at once instead of after uploading.
    if (file.size > IMPORT_MAX_BYTES) {
      dispatchRecords({ type: "import_failed", message: TOO_LARGE, details: [] });
      return;
    }
    void runImport(async () => api.importFile(await file.text(), timezone));
  };

  const remove = async (id: string) => {
    dispatchRecords({ type: "remove_start", id });
    try {
      await api.removeRecord(id);
      dispatchRecords({ type: "removed", id });
    } catch (error) {
      dispatchRecords({ type: "remove_failed", id, message: failureMessage(error, "The record couldn't be removed. Try again.") });
    }
  };

  const clearAll = async () => {
    try {
      await api.clearAll();
      dispatchRecords({ type: "cleared" });
      // Chats are cleared too, so the open one is gone.
      newChat();
    } catch (error) {
      dispatchRecords({ type: "clear_failed", message: failureMessage(error, "Memory couldn't be cleared. Try again.") });
    }
  };

  const openPanel = (record: ViewedRecord | null) => {
    panelTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : recordsButton.current;
    setViewing(record);
    setPanelOpen(true);
  };

  const closePanel = () => {
    setPanelOpen(false);
    setViewing(null);
    // Focus goes back to whatever opened the panel: the Records button or a chip.
    requestAnimationFrame(() => (panelTrigger.current ?? recordsButton.current)?.focus());
  };

  const openChip = (chip: MemoryChip, quotes: string[]) => openPanel({ id: chip.id, quotes });

  const blocked = !online ? "offline" : health?.cerebras === false ? "missing_key" : null;
  const showWelcome = chat.messages.length === 0 && !startedWithout && !restoring && records.phase !== "loading";
  const last = chat.messages.at(-1);

  return (
    <div className={styles.app}>
      <a href="#composer-input" className={styles.skip}>
        Skip to message box
      </a>
      <Header
        recordCount={records.phase === "ready" ? records.records.length : null}
        onOpenRecords={() => openPanel(null)}
        onNewChat={newChat}
        recordsRef={recordsButton}
      />

      <div className={styles.banners}>
        {serverDown !== null && <Banner tone="danger">{serverDown}</Banner>}
        {health?.cerebras === false && <Banner tone="danger">Add CEREBRAS_API_KEY to .env and restart the server.</Banner>}
        {!online && <Banner tone="danger">You're offline. Messages will send when you're back.</Banner>}
        {saveFailed && <Banner tone="danger">This chat can't be saved right now. You can keep talking.</Banner>}
        {records.phase === "error" && records.loadError !== null && <Banner tone="danger">{records.loadError}</Banner>}
        {health?.tavily === false && (
          <Banner tone="info">Web search is off. Add TAVILY_API_KEY to .env to turn it on. Questions about your records still work.</Banner>
        )}
      </div>

      <main className={styles.main}>
        <div className={styles.column}>
          {showWelcome && (
            <WelcomeCard
              records={records.records.filter((record) => record.id !== chat.threadId)}
              importState={records.import}
              timezone={timezone}
              onLoadSample={() => void loadSample()}
              onUpload={upload}
              onDrag={(over) => dispatchRecords({ type: "drag", over })}
              onStartWithout={() => {
                setStartedWithout(true);
                composer.current?.focus();
              }}
              onAsk={(question) => void ask(question)}
            />
          )}
          {chat.messages.length === 0 && !showWelcome && !restoring && (
            <p className={styles.empty}>Ask about a meeting, a decision or a date. Records can be loaded any time from Records.</p>
          )}
          <MessageList
            messages={chat.messages}
            timezone={timezone}
            onOpenChip={openChip}
            onRetry={streaming ? null : (key) => {
              const message = chat.messages.find((item) => item.key === key);
              if (message?.kind === "assistant") void ask(message.question, key);
            }}
          />
        </div>
      </main>

      <div className={styles.dock}>
        <div className={styles.column}>
          {!atBottom && chat.messages.length > 0 && (
            <button type="button" className={styles.jump} onClick={jumpToLatest}>
              Jump to latest
            </button>
          )}
          <Composer streaming={streaming} blocked={blocked} onSend={(text) => void ask(text)} onStop={stop} inputRef={composer} />
        </div>
      </div>

      {/* Status and errors are announced; the streaming text is not, only "Answer ready" at the end. */}
      <div className="sr-only" aria-live="polite" role="status">
        {last?.kind === "assistant" ? announcement(last) : ""}
      </div>

      <RecordsPanel
        open={panelOpen}
        state={records}
        timezone={timezone}
        viewing={viewing}
        onView={setViewing}
        onClose={closePanel}
        onReload={() => void loadRecords()}
        onRemove={(id) => void remove(id)}
        onClearAll={() => void clearAll()}
        onLoadSample={() => void loadSample()}
        onUpload={upload}
      />
    </div>
  );
}

function announcement(message: Extract<ChatState["messages"][number], { kind: "assistant" }>): string {
  switch (message.phase) {
    case "pending":
    case "streaming":
      return message.status ?? "";
    case "complete":
      return "Answer ready";
    case "stopped":
      return "Stopped.";
    case "incomplete":
      return "Connection lost. This answer is incomplete.";
    case "error":
      return message.error?.message ?? "";
  }
}
