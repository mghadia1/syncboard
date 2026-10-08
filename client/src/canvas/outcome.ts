import type { Outcome } from "../board/editor";

/** What an undo or redo did, in words; it says so when it left others' changes alone. */
export function describeOutcome(outcome: Outcome, done: "Undid" | "Redid"): string {
  if (outcome.kept === 0) {
    return `${done} ${outcome.label}`;
  }
  if (outcome.reverted === 0) {
    return `Could not ${done === "Undid" ? "undo" : "redo"} ${outcome.label}: someone else has changed it since`;
  }
  return `${done} ${outcome.label}, except what someone else has changed since`;
}
