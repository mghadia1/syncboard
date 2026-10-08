import { useState } from "react";
import { Editor } from "./board/editor";
import { Whiteboard } from "./canvas/Whiteboard";
import { type Connection, type CreateSocket, socketUrl, useConnection } from "./connection";

function ConnectionBadge({ connection }: { connection: Connection }) {
  switch (connection.state) {
    case "connecting":
      return <span className="badge badge-waiting">Connecting…</span>;
    case "connected":
      return (
        <span className="badge badge-ok">
          Connected <span className="badge-detail">server {connection.version}</span>
        </span>
      );
    case "refused":
      return (
        <span className="badge badge-bad">
          Refused <span className="badge-detail">{connection.reason}</span>
        </span>
      );
    case "disconnected":
      return (
        <span className="badge badge-bad">
          Disconnected <span className="badge-detail">reload to try again</span>
        </span>
      );
  }
}

export function App({ url, create, editor }: { url?: string; create?: CreateSocket; editor?: Editor }) {
  const connection = useConnection(url ?? socketUrl(), create);
  const [board] = useState(() => editor ?? new Editor());
  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">SyncBoard</h1>
        <div role="status" aria-live="polite" aria-label="Connection">
          <ConnectionBadge connection={connection} />
        </div>
      </header>
      <Whiteboard editor={board} />
    </div>
  );
}
