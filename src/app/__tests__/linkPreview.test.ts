import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadata } from "../siteMetadata";

describe("link preview", () => {
  it("gives chat apps and X an absolute preview image and a large card", () => {
    expect(String(metadata.metadataBase)).toBe("https://wrapped.notatowel.com/");
    const og = metadata.openGraph as { images?: { url: string; width: number; height: number }[] };
    expect(og.images?.[0]).toMatchObject({ url: "/og.png", width: 1200, height: 630 });
    expect((metadata.twitter as { card?: string }).card).toBe("summary_large_image");
  });

  it("ships the preview image as a real 1200x630 PNG", () => {
    const png = readFileSync("public/og.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("uses its own icon, not the Next.js starter's Vercel triangle", () => {
    expect(existsSync("src/app/favicon.ico")).toBe(false);
    expect(existsSync("src/app/icon.svg")).toBe(true);
    expect(readFileSync("src/app/apple-icon.png").readUInt32BE(16)).toBe(180);
    for (const f of ["vercel.svg", "next.svg", "file.svg", "globe.svg", "window.svg"]) expect(existsSync(`public/${f}`)).toBe(false);
  });
});
