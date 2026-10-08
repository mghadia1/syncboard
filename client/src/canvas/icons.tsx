import type { Tool } from "./tools";

/** 20x20 line icons, drawn for this app; they take the text color. */
const PATHS: Readonly<Record<Tool | "undo" | "redo" | "front" | "back" | "trash", string>> = {
  select: "M5 3 L5 16 L8.6 12.6 L11 17.5 L13 16.6 L10.7 11.8 L15.5 11.6 Z",
  hand: "M7 10 V5 a1.3 1.3 0 0 1 2.6 0 V9 M9.6 9 V3.8 a1.3 1.3 0 0 1 2.6 0 V9 M12.2 9 V5 a1.3 1.3 0 0 1 2.6 0 V12 c0 3 -2 5 -5 5 c-2.4 0 -3.6 -1.2 -4.8 -3.2 L3.4 11 a1.2 1.2 0 0 1 2 -1.3 L7 11.6",
  rectangle: "M3.5 5.5 H16.5 V14.5 H3.5 Z",
  ellipse: "M10 4.5 C14 4.5 17 7 17 10 C17 13 14 15.5 10 15.5 C6 15.5 3 13 3 10 C3 7 6 4.5 10 4.5 Z",
  arrow: "M4 16 L16 4 M9.5 4 H16 V10.5",
  pen: "M3.5 14.5 C6 9 8 15 10.5 10 C12.5 6 14.5 9 16.5 5",
  note: "M4 3.5 H16 V12.5 L12.5 16.5 H4 Z M12.5 16.5 V12.5 H16 M6.5 7.5 H13.5 M6.5 10 H11",
  undo: "M7.5 6 L4 9.5 L7.5 13 M4 9.5 H12 a4 4 0 0 1 0 8 H9",
  redo: "M12.5 6 L16 9.5 L12.5 13 M16 9.5 H8 a4 4 0 0 0 0 8 H11",
  front: "M3.5 8 H11 V15.5 H3.5 Z M7 4.5 H16.5 V12",
  back: "M9 4.5 H16.5 V12 H9 Z M3.5 8 V15.5 H11",
  trash: "M4 6 H16 M8 6 V4 H12 V6 M5.5 6 L6.5 16.5 H13.5 L14.5 6 M8.5 9 V13.5 M11.5 9 V13.5",
};

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
