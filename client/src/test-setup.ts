import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom has pointer events but not pointer capture; the board only needs
// the calls to exist.
const captured = new WeakMap<Element, Set<number>>();
Element.prototype.setPointerCapture = function (this: Element, id: number) {
  const ids = captured.get(this) ?? new Set<number>();
  ids.add(id);
  captured.set(this, ids);
};
Element.prototype.releasePointerCapture = function (this: Element, id: number) {
  captured.get(this)?.delete(id);
};
Element.prototype.hasPointerCapture = function (this: Element, id: number) {
  return captured.get(this)?.has(id) ?? false;
};
