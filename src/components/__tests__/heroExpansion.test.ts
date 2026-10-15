import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: () => ({ current: null }),
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
}));
vi.mock("motion/react", () => ({ motion: { p: "p", form: "form" }, useReducedMotion: () => true }));
import { Hero } from "../Hero";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function render(keysOpen: boolean) {
  hooks.cursor = 0;
  hooks.effects = [];
  return elements(Hero({ keysOpen, onRun: vi.fn(), streamer: true, keys: {}, onKeysChange: vi.fn(), remember: false, onRemember: vi.fn() }));
}
beforeEach(() => { hooks.values = []; });
it("opens for sign-in and lets the user collapse while keysOpen stays true", () => {
  const initial = render(true);
  const button = initial.find((node) => node.props.children === "Run it on any channel")!;
  expect(button.props["aria-expanded"]).toBe(true);
  (button.props.onClick as () => void)();
  const collapsed = render(true);
  expect(collapsed.find((node) => node.props.children === "Run it on any channel")!.props["aria-expanded"]).toBe(false);
  expect(collapsed.some((node) => node.props.callbackError !== undefined || node.type === "form")).toBe(false);
});
it("opens when keysOpen becomes true after the initial render", () => {
  render(false);
  render(true);
  hooks.effects[0]();
  expect(render(true).find((node) => node.props.children === "Run it on any channel")!.props["aria-expanded"]).toBe(true);
});
