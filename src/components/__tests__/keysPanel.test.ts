import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KeysPanel } from "../KeysPanel";

const render = (keys = {}) => renderToStaticMarkup(createElement(KeysPanel, { keys, onChange: vi.fn(), remember: false, onRemember: vi.fn() }));

describe("KeysPanel", () => {
  it("renders three labelled sections and password fields", () => {
    const html = render();
    for (const label of ["ScaleDown key", "OpenRouter", "YouTube Data API key", "Sign in with OpenRouter", "Test my keys", "Remember on this device", "Forget keys"]) expect(html).toContain(label);
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toMatch(/for="(scaledown-key[^"]+)"/);
    const scaledownId = html.match(/for="(scaledown-key[^"]+)"/)![1];
    expect(html).toContain(`id="${scaledownId}"`);
    const youtubeId = html.match(/for="(youtube-key[^"]+)"/)![1];
    expect(html).toContain(`id="${youtubeId}"`);
    expect(html).not.toContain('checked=""');
    expect(html).toContain("This site has no server.");
    expect(html).toContain("tab closes");
  });
  it("renders the setup deep links with safe new-tab attributes", () => {
    const html = render();
    for (const url of ["https://scaledown.xyz", "https://console.cloud.google.com/projectcreate", "https://console.cloud.google.com/apis/library/youtube.googleapis.com", "https://console.cloud.google.com/apis/credentials"]) {
      expect(html).toContain(`href="${url}" target="_blank" rel="noopener noreferrer"`);
    }
    expect(html).toContain("Websites");
    expect(html).toContain("no billing needed");
  });
  it("shows connected state for a pasted OpenRouter key", () => {
    const html = render({ openrouter: "sk-test" });
    expect(html).toContain("Connected");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Sign in with OpenRouter");
    expect(html).not.toContain("sk-test");
  });
});
