"use client";

import { useSyncExternalStore } from "react";

export interface Keys {
  scaledown?: string;
  openrouter?: string;
  youtube?: string;
}

export interface KeyState {
  keys: Keys;
  remember: boolean;
}

const STORAGE_KEY = "comment-wrapped.keys";
const EMPTY: KeyState = { keys: {}, remember: false };
let memory: KeyState | undefined;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    memory = undefined;
    listeners.forEach((listener) => listener());
  });
}

export function trimKeys(keys: Keys): Keys {
  const clean: Keys = {};
  for (const name of ["scaledown", "openrouter", "youtube"] as const) {
    const value = typeof keys[name] === "string" ? keys[name]?.trim() : undefined;
    if (value) clean[name] = value;
  }
  return clean;
}

function readStorage(name: "sessionStorage" | "localStorage"): Keys | null {
  try {
    const raw = globalThis[name]?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return trimKeys(parsed as Keys);
  } catch {
    return null;
  }
}

function writeStorage(name: "sessionStorage" | "localStorage", keys: Keys | null): void {
  try {
    if (keys) globalThis[name]?.setItem(STORAGE_KEY, JSON.stringify(keys));
    else globalThis[name]?.removeItem(STORAGE_KEY);
  } catch {
    // Memory remains usable when browser storage is disabled or full.
  }
}

export function loadKeys(): KeyState {
  if (memory) return memory;
  const local = readStorage("localStorage");
  memory = local ? { keys: local, remember: true } : { keys: readStorage("sessionStorage") ?? {}, remember: false };
  return memory;
}

export function saveKeys(keys: Keys, remember = false): void {
  memory = { keys: trimKeys(keys), remember };
  writeStorage(remember ? "sessionStorage" : "localStorage", null);
  writeStorage(remember ? "localStorage" : "sessionStorage", memory.keys);
  listeners.forEach((listener) => listener());
}

export function clearKeys(): void {
  memory = { keys: {}, remember: false };
  writeStorage("sessionStorage", null);
  writeStorage("localStorage", null);
  listeners.forEach((listener) => listener());
}

export function keysToEnv(keys: Keys): Record<"SCALEDOWN_API_KEY" | "OPENROUTER_API_KEY" | "YOUTUBE_API_KEY", string | undefined> {
  const clean = trimKeys(keys);
  return { SCALEDOWN_API_KEY: clean.scaledown, OPENROUTER_API_KEY: clean.openrouter, YOUTUBE_API_KEY: clean.youtube };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useKeys() {
  const state = useSyncExternalStore(subscribe, loadKeys, () => EMPTY);
  return {
    ...state,
    setKeys: (keys: Keys) => saveKeys(keys, loadKeys().remember),
    setRemember: (remember: boolean) => saveKeys(loadKeys().keys, remember),
    clearKeys,
  };
}
