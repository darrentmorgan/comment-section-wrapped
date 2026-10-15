// Server-internal types (not part of the UI contract).
import type { VideoInfo } from "./types";

export interface RawComment {
  id: string;
  videoId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  text: string;
  likes: number;
  publishedAt: string;
  replyCount: number;
}

export interface ResolvedChannel {
  id: string;
  title: string;
  handle: string;
  avatar: string;
  uploadsPlaylistId: string;
  subscriberCount?: number;
  videoCount: number;
}

export interface VideoMeta extends VideoInfo {
  commentsDisabled: boolean;
  durationSec: number;
  viewCount: number;
}
