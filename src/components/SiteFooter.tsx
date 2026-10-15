import Link from "next/link";

export function SiteFooter({
  sha = process.env.NEXT_PUBLIC_COMMIT_SHA || "dev",
  repo = process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/darrentmorgan/comment-section-wrapped",
}: { sha?: string; repo?: string }) {
  const source = repo.replace(/\/$/, "");
  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 py-5 text-[13px] text-mute">
      <Link href="/privacy/" className="hover:text-bone">Privacy</Link>
      <a href={source} className="hover:text-bone">Source</a>
      {sha === "dev" ? <span>dev build</span> : (
        <a href={`${source}/commit/${sha}`} className="hover:text-bone">Running commit {sha.slice(0, 7)}</a>
      )}
    </footer>
  );
}
