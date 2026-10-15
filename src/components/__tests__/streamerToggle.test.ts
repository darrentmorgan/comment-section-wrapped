import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StreamerToggle } from "../mask";

const render = (on: boolean) => renderToStaticMarkup(createElement(StreamerToggle, { on, onChange: vi.fn() }));

describe("StreamerToggle", () => {
  it("says On and lights the track with a light knob on the right when on", () => {
    const html = render(true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">On<");
    expect(html).toContain("bg-supportive");
    expect(html).toMatch(/bg-bone[^"]*translate-x-\[22px\]/);
  });

  it("pins the knob to the track's left edge so translate moves it from there", () => {
    for (const on of [true, false]) expect(render(on)).toMatch(/absolute left-0 /);
  });

  it("says Off with a dim track and the knob on the left when off", () => {
    const html = render(false);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(">Off<");
    expect(html).not.toContain("bg-supportive");
    expect(html).toMatch(/translate-x-0\.5/);
  });
});
