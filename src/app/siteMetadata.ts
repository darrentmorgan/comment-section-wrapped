import type { Metadata } from "next";

const title = "Comment Section Wrapped";
const description = "An experiment: 7 AI models read 59,751 MrBeast comments. Watch the recorded run, or bring your own keys and read any channel. Keys stay in your browser.";

// Chat apps and X need absolute image URLs, hence metadataBase.
export const metadata: Metadata = {
  metadataBase: new URL("https://wrapped.notatowel.com"),
  title,
  description,
  openGraph: {
    type: "website",
    url: "/",
    siteName: title,
    title,
    description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "I made AI read your whole comment section." }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};
