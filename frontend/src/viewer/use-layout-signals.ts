"use client";

import { useCallback, useSyncExternalStore, type RefObject } from "react";

/**
 * The content width of an element in CSS pixels, kept current with ResizeObserver.
 * Read through useSyncExternalStore so the first measurement lands before paint.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const element = ref.current;
      if (element === null || typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(onChange);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [ref],
  );
  const read = useCallback(() => {
    const element = ref.current;
    if (element === null) return 0;
    const style = getComputedStyle(element);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return Math.max(0, element.clientWidth - (Number.isFinite(padding) ? padding : 0));
  }, [ref]);
  return useSyncExternalStore(subscribe, read, () => 0);
}

/**
 * window.devicePixelRatio, updated when it changes (browser zoom, moving the window to
 * another screen). The media query matches only the current ratio, so it fires on any
 * change and is then replaced by one for the new ratio.
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeToRatio, readRatio, () => 1);
}

function readRatio(): number {
  const ratio = window.devicePixelRatio;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
}

function subscribeToRatio(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener("change", changed);
    query = window.matchMedia(`(resolution: ${readRatio()}dppx)`);
    query.addEventListener("change", changed);
  };
  const changed = () => {
    listen();
    onChange();
  };
  listen();
  return () => query?.removeEventListener("change", changed);
}
