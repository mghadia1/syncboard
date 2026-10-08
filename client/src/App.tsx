import type { Presence } from "@syncboard/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { People } from "./People";
import { Editor } from "./board/editor";
import { Whiteboard } from "./canvas/Whiteboard";
import { colorFor, loadName, saveName } from "./sync/identity";
import { type CreateSocket, Sync, type SyncStatus } from "./sync/sync";
import { boardFromLocation, socketUrl } from "./sync/where";

function plural(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? "" : "s"}`;
}

function StatusBadge({ status }: { status: SyncStatus }) {
  switch (status.state) {
    case "connecting":
      return <span className="badge badge-waiting">Connecting…</span>;
    case "online":
      return (
        <span className="badge badge-ok">
          Connected{" "}
          <span className="badge-detail">
            {status.pending > 0 ? `sending ${plural(status.pending, "change")}` : `server ${status.version}`}
          </span>
        </span>
      );
    case "offline":
      return (
        <span className="badge badge-waiting">
          Offline{" "}
          <span className="badge-detail">
            {status.pending > 0 ? `${plural(status.pending, "change")} waiting, ` : ""}reconnecting
          </span>
        </span>
      );
    case "refused":
      return (
        <span className="badge badge-bad">
          Refused <span className="badge-detail">{status.reason}</span>
        </span>
      );
  }
}

export type AppProps = {
  url?: string;
  board?: string;
  create?: CreateSocket;
  editor?: Editor;
  retry?: { firstMs: number; maxMs: number };
  /** Who you are; by default the name kept in this browser. */
  name?: string;
};

export function App({ url, board, create, editor, retry, name: givenName }: AppProps) {
  const [name, setName] = useState(() => givenName ?? loadName());
  const [session] = useState(() => {
    const e = editor ?? new Editor();
    const sync = new Sync({
      editor: e,
      board: board ?? boardFromLocation(),
      url: url ?? socketUrl(),
      presence: { name, color: colorFor(name), cursor: null, selection: [] },
      ...(create ? { createSocket: create } : {}),
      ...(retry ? { retry } : {}),
    });
    return { editor: e, sync };
  });
  const status = useSyncExternalStore(session.sync.subscribe, session.sync.getStatus);
  const peers = useSyncExternalStore(session.sync.subscribe, session.sync.getPeers);
  const sharePresence = useCallback(
    (change: Partial<Presence>) => {
      session.sync.setPresence(change);
    },
    [session],
  );

  function rename(next: string) {
    setName(next);
    saveName(next);
    session.sync.setPresence({ name: next, color: colorFor(next) });
  }
  const [copied, setCopied] = useState("");

  useEffect(() => {
    session.sync.start();
    return () => {
      session.sync.stop();
    };
  }, [session]);

  function copyLink() {
    const say = (text: string) => {
      setCopied(text);
      setTimeout(() => {
        setCopied("");
      }, 2500);
    };
    // The clipboard API exists only on HTTPS and localhost; a board on a
    // LAN address is plain HTTP.
    const clipboard = (navigator as Partial<Navigator>).clipboard;
    if (!clipboard) {
      say("Copy the address bar");
      return;
    }
    clipboard.writeText(window.location.href).then(
      () => {
        say("Link copied");
      },
      () => {
        say("Copy the address bar");
      },
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">SyncBoard</h1>
        <div role="status" aria-live="polite" aria-label="Connection">
          <StatusBadge status={status} />
        </div>
        <People name={name} peers={peers} online={status.state === "online"} onRename={rename} />
        <button type="button" className="copy-link" onClick={copyLink} title="Anyone with the link can draw on this board">
          {copied || "Copy link"}
        </button>
      </header>
      <Whiteboard editor={session.editor} peers={peers} onPresence={sharePresence} />
    </div>
  );
}
