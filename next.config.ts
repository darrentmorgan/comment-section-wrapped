import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

function commitSha(): string {
  const supplied = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
  if (supplied) return supplied;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "dev";
  } catch {
    return "dev";
  }
}

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_COMMIT_SHA: commitSha(),
    NEXT_PUBLIC_REPO_URL: process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/darrentmorgan/comment-section-wrapped",
  },
};

export default nextConfig;
