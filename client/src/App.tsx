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

export function App({ url, create }: { url?: string; create?: CreateSocket }) {
  const connection = useConnection(url ?? socketUrl(), create);
  return (
    <div className="app">
      <header className="bar">
        <h1 className="wordmark">SyncBoard</h1>
        <div role="status" aria-live="polite">
          <ConnectionBadge connection={connection} />
        </div>
      </header>
      <main className="board" aria-label="Board">
        <p className="empty">Nothing to draw on yet.</p>
      </main>
    </div>
  );
}
