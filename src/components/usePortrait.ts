"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(orientation: portrait)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True on a portrait viewport (phone, 1080x1920 recordings). False during SSR. */
export function usePortrait(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
