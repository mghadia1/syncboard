import type { Presence } from "@syncboard/shared";
import { MAX_NAME_LENGTH } from "@syncboard/shared";
import { type CSSProperties, useState } from "react";
import { cleanName, colorFor } from "./sync/identity";

const SHOWN = 5;

function initials(name: string): string {
  const words = name.split(" ").filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

const person = (color: string) => ({ "--person": `var(--marker-${color})` }) as CSSProperties;

/** Who is on the board: you first (click to rename), then the others. */
export function People({
  name,
  peers,
  online,
  onRename,
}: {
  name: string;
  peers: ReadonlyMap<string, Presence>;
  online: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const others = [...peers.values()];

  function finish(typed: string) {
    const cleaned = cleanName(typed);
    if (cleaned && cleaned !== name) {
      onRename(cleaned);
    }
    setEditing(false);
  }

  return (
    <div className="people" role="group" aria-label="People on this board">
      {editing ? (
        <input
          className="rename"
          aria-label="Your name"
          defaultValue={name}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          onFocus={(event) => {
            // Typing replaces the name; arrows still edit it.
            event.currentTarget.select();
          }}
          onBlur={(event) => {
            finish(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              finish(event.currentTarget.value);
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="person me"
          style={person(colorFor(name))}
          aria-label={`You, ${name}: change your name`}
          title={`You: ${name} (click to rename)`}
          onClick={() => {
            setEditing(true);
          }}
        >
          {initials(name)}
        </button>
      )}
      {others.slice(0, SHOWN).map((other, i) => (
        <span key={`${other.name}-${String(i)}`} className="person" style={person(other.color)} role="img" aria-label={other.name} title={other.name}>
          {initials(other.name)}
        </span>
      ))}
      {others.length > SHOWN && (
        <span className="person more" title={others.slice(SHOWN).map((o) => o.name).join(", ")}>
          +{others.length - SHOWN}
        </span>
      )}
      <span className="visually-hidden">
        {online ? (others.length === 0 ? "Only you here" : `${String(others.length)} others here`) : "Offline: who else is here is unknown"}
      </span>
    </div>
  );
}
