// Renders public/og.png, the 1200x630 link preview for chat apps and X. Run: pnpm og
/** @jsxImportSource react */

import { readFileSync, writeFileSync } from "node:fs";
import { ImageResponse } from "next/og";
import React from "react";
void React;

const INK = "#15130f";
const BONE = "#efe8da";
const MUTE = "#9a9282";
// The recorded MrBeast run's mood mix, so the bar is real data, not decoration.
const MOOD = [
  { color: "#7fa88a", share: 65 },
  { color: "#a98fb0", share: 12 },
  { color: "#7e98b0", share: 9 },
  { color: "#d08a52", share: 8 },
  { color: "#8a8273", share: 4 },
];

// Satori needs TTF/OTF, so ask Google Fonts with a user agent that gets TTF back.
async function font(family: string, weight: number): Promise<ArrayBuffer> {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1)" } })).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
  if (!url) throw new Error(`no TTF for ${family}`);
  return (await fetch(url)).arrayBuffer();
}

async function main() {
  const [display, sans] = await Promise.all([font("Fraunces", 600), font("Inter", 500)]);
  const img = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: INK, color: BONE, padding: "72px 80px", fontFamily: "Inter" }}>
        <div style={{ display: "flex", fontSize: 26, letterSpacing: 4, color: MUTE, textTransform: "uppercase" }}>Comment Section Wrapped</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: "Fraunces", fontSize: 92, lineHeight: 1.02, letterSpacing: -2 }}>I made AI read your</div>
          <div style={{ fontFamily: "Fraunces", fontSize: 92, lineHeight: 1.02, letterSpacing: -2 }}>whole comment section.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", height: 22, width: "100%" }}>
            {MOOD.map((m, i) => (
              <div key={i} style={{ display: "flex", flexGrow: m.share, background: m.color }} />
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 30, color: MUTE }}>7 models · 59,751 MrBeast comments · bring your own keys</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Fraunces", data: display, weight: 600, style: "normal" },
        { name: "Inter", data: sans, weight: 500, style: "normal" },
      ],
    },
  );
  writeFileSync("public/og.png", Buffer.from(await img.arrayBuffer()));
  // iMessage and iOS home screens want a PNG touch icon; this is src/app/icon.svg at 180px.
  const svg = readFileSync("src/app/icon.svg", "utf8");
  // eslint-disable-next-line @next/next/no-img-element -- satori renders plain img, not next/image
  const icon = new ImageResponse(<img width={180} height={180} src={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`} alt="" />, { width: 180, height: 180 });
  writeFileSync("src/app/apple-icon.png", Buffer.from(await icon.arrayBuffer()));
  console.log("wrote public/og.png and src/app/apple-icon.png");
}

void main();
