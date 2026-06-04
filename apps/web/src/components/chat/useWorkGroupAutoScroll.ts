import { type MutableRefObject, type RefObject, useEffect, useRef } from "react";

import { isScrollContainerNearBottom } from "../../chat-scroll";

/** Breathing room kept below the workgroup's last entry while following. */
const FOLLOW_BOTTOM_GAP_PX = 12;

interface WorkGroupAutoScrollOptions {
  /** The chat timeline's scroll container, or null before it mounts. */
  scrollContainer: HTMLElement | null;
  /** The workgroup root element whose bottom should stay in view. */
  groupRef: RefObject<HTMLElement | null>;
  /**
   * Whether this workgroup should own the smooth follow — true while it is
   * expanded and actively streaming new tool calls.
   */
  isActive: boolean;
  /** Rendered entry count; a change signals that a new tool call arrived. */
  entryCount: number;
  /**
   * Shared counter that tells the global stick-to-bottom to stand down while a
   * workgroup owns the smooth follow, so its instant jump cannot mask the
   * smooth animation below.
   */
  globalAutoScrollSuppressRef: MutableRefObject<number>;
}

/**
 * Smoothly keeps the bottom of an active workgroup (its latest tool call) in
 * view as entries stream in. Following pauses the moment the user scrolls up
 * and resumes once they scroll back down to the bottom.
 */
export function useWorkGroupAutoScroll({
  scrollContainer,
  groupRef,
  isActive,
  entryCount,
  globalAutoScrollSuppressRef,
}: WorkGroupAutoScrollOptions): void {
  const isFollowingRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  // While this workgroup streams, claim ownership of the follow so the global
  // stick-to-bottom defers to the smooth scroll below. Entering the active
  // state re-engages following (e.g. for a fresh turn).
  useEffect(() => {
    if (!isActive) return;
    isFollowingRef.current = true;
    globalAutoScrollSuppressRef.current += 1;
    return () => {
      globalAutoScrollSuppressRef.current -= 1;
    };
  }, [isActive, globalAutoScrollSuppressRef]);

  // Pause following when the user scrolls up; resume when they return to the
  // bottom. Our own smooth scrolls only move downward, so they never pause it.
  useEffect(() => {
    if (!scrollContainer || !isActive) return;
    lastScrollTopRef.current = scrollContainer.scrollTop;
    const handleScroll = () => {
      const { scrollTop } = scrollContainer;
      const scrolledUp = scrollTop < lastScrollTopRef.current - 1;
      lastScrollTopRef.current = scrollTop;
      if (scrolledUp) {
        isFollowingRef.current = false;
      } else if (isScrollContainerNearBottom(scrollContainer)) {
        isFollowingRef.current = true;
      }
    };
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, [scrollContainer, isActive]);

  // Glide to the workgroup bottom after each new entry, once layout settles.
  useEffect(() => {
    if (!isActive || !isFollowingRef.current) return;
    const container = scrollContainer;
    const group = groupRef.current;
    if (!container || !group) return;
    const frame = window.requestAnimationFrame(() => {
      const delta = group.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
      if (delta <= 0) return; // already fully visible
      container.scrollTo({
        top: container.scrollTop + delta + FOLLOW_BOTTOM_GAP_PX,
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryCount, isActive, scrollContainer, groupRef]);
}
