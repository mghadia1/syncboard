import { MAX_TEXT_LENGTH, type Shape } from "@syncboard/shared";
import { useState } from "react";
import type { Editor } from "../board/editor";
import { type Viewport, bounds, round, toScreen } from "../board/geometry";

/**
 * A text box laid over a note while its text is edited. Every keystroke is
 * an edit of the note (so others will see the typing in Milestone 3); the
 * whole session is one undo step, opened and closed by the board. The note
 * grows to fit its text: it never hides any (found in the browser, where a
 * small note cut its text off mid-word).
 */
export function NoteEditor({
  editor,
  note,
  view,
  onDone,
}: {
  editor: Editor;
  note: Shape;
  view: Viewport;
  onDone: () => void;
}) {
  const [text, setText] = useState(note.text);
  const box = bounds(note);
  const corner = toScreen(view, { x: box.left, y: box.top });
  return (
    <textarea
      className="note-editor"
      aria-label="Note text"
      autoFocus
      maxLength={MAX_TEXT_LENGTH}
      value={text}
      style={{
        left: corner.x,
        top: corner.y,
        width: (box.right - box.left) * view.zoom,
        height: (box.bottom - box.top) * view.zoom,
        fontSize: 18 * view.zoom,
        padding: 12 * view.zoom,
      }}
      onChange={(event) => {
        const value = event.target.value;
        setText(value);
        // The text box already holds the new text, and is laid out exactly
        // like the note (same width, padding, font), so its scroll height
        // is the height the note needs.
        const needed = event.target.scrollHeight / view.zoom;
        const height = box.bottom - box.top;
        editor.update(note.id, needed > height + 1 ? { text: value, h: round(needed) } : { text: value });
      }}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          onDone();
        }
      }}
    />
  );
}
