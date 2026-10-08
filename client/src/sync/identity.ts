import { type Color, MAX_NAME_LENGTH, PERSON_COLORS } from "@syncboard/shared";

/**
 * Who you are on a board: a name, generated the first time and kept in
 * this browser (until changed), and a color that follows from the name, so
 * the same name looks the same to everyone. There are no accounts: the
 * name is only what others see.
 */

const ADJECTIVES = ["Amber", "Cobalt", "Coral", "Indigo", "Jade", "Ochre", "Olive", "Plum", "Rust", "Sage", "Slate", "Teal"];
const ANIMALS = ["Badger", "Finch", "Gecko", "Heron", "Ibis", "Koala", "Lynx", "Marten", "Otter", "Puffin", "Tapir", "Wren"];

const KEY = "syncboard.name";

export function randomName(random: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.floor(random() * list.length)] ?? list[0] ?? "";
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** A color for a name: the same name, the same color, everywhere. */
export function colorFor(name: string): Color {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return PERSON_COLORS[hash % PERSON_COLORS.length] ?? "blue";
}

/** A name as typed, tidied; null if nothing is left of it. */
export function cleanName(typed: string): string | null {
  const name = typed.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
  return name === "" ? null : name;
}

/**
 * The name kept in this browser, or a new one (kept from now on).
 * Storage can be missing or refuse (a private window): then the name
 * lasts as long as the page.
 */
export function loadName(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  try {
    const kept = cleanName(storage?.getItem(KEY) ?? "");
    if (kept) {
      return kept;
    }
  } catch {
    // storage refused: fall through to a new name
  }
  const name = randomName();
  saveName(name, storage);
  return name;
}

export function saveName(name: string, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, name);
  } catch {
    // storage refused: the name lasts as long as the page
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
