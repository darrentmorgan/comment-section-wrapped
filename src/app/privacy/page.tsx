import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";

export default function Privacy() {
  return (
    <main className="mx-auto max-w-[760px] px-6 py-20 text-bone">
      <Link href="/" className="kicker hover:text-bone">Comment Section Wrapped</Link>
      <h1 className="display mt-10 text-6xl">Privacy</h1>
      <div className="mt-8 space-y-6 text-base leading-relaxed text-mute [&_a]:text-bone [&_a]:underline [&_a]:underline-offset-4">
        <p>This is a static site: no server, no accounts, no analytics and no cookies.</p>
        <p>Your API keys stay in your browser, in this tab only unless you choose “Remember on this device”. Keys are sent only to the provider they belong to: ScaleDown, OpenRouter or Google. Use “Forget keys” to remove them from this browser.</p>
        <p>The site uses browser storage only: session storage for keys and the sign-in handshake, and local storage for keys only if you tick Remember on this device.</p>
        <p>Thumbnails and avatars load from YouTube/Google image hosts, which can see your IP address.</p>
        <p>Comments you analyse are fetched by your browser from YouTube with your key. The app processes the results in your browser and sends comment text to your chosen classifier, ScaleDown or OpenRouter, for analysis. Comments are never uploaded to this site or stored by it.</p>
        <p>The demo includes a small sample of public comments with names and comment ids masked. Streamer mode is on by default. Please do not use the results to target individuals.</p>
        <p>This app uses YouTube API Services. See the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. You can <a href="https://security.google.com/settings/security/permissions">revoke access in your Google security settings</a> or delete the API key in the Google Cloud console.</p>
        <p>The <a href={process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/darrentmorgan/comment-section-wrapped"}>source code</a> is available to inspect.</p>
      </div>
      <div className="mt-12 border-t border-line"><SiteFooter /></div>
    </main>
  );
}
