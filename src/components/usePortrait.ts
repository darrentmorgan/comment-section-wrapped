"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(orientation: portrait)";
/** Matches the phone block in globals.css: a portrait screen no wider than a large phone. */
const PHONE = "(orientation: portrait) and (max-width: 640px)";
const subscriber = (query: string) => (cb: () => void) => {
  const mq = window.matchMedia(query);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const subscribe = subscriber(QUERY);
const subscribePhone = subscriber(PHONE);

/** True on a portrait viewport (phone, 1080x1920 recordings). False during SSR. */
export function usePortrait(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** True on a phone-sized portrait screen, where slides use the phone type scale and smaller avatars. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}
