import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import Privacy from "@/app/privacy/page";
import { Avatar } from "../mask";

it("discloses image host IP visibility and browser storage choices", () => {
  const html = renderToStaticMarkup(createElement(Privacy));
  for (const text of ["YouTube/Google image hosts", "IP address", "session storage", "sign-in handshake", "local storage", "Remember"]) expect(html).toContain(text);
});
it("prevents referrers on avatars and both thumbnail views", () => {
  const html = renderToStaticMarkup(createElement(Avatar, { name: "Channel", src: "https://yt3.ggpht.com/avatar", alwaysShow: true }));
  expect(html).toContain('referrerPolicy="no-referrer"');
  for (const file of ["src/components/Reading.tsx", "src/components/Story.tsx"]) {
    const source = readFileSync(file, "utf8");
    const images = source.match(/<img\b[\s\S]*?\/>/g)!;
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toContain('referrerPolicy="no-referrer"');
  }
});
