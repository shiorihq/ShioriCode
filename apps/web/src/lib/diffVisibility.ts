export function hasVisibleDiffContent(root: ParentNode | null): boolean {
  if (root === null) return false;

  if ((root.textContent?.trim().length ?? 0) > 0) {
    return true;
  }

  return Array.from(root.querySelectorAll<HTMLElement>("*")).some((node) => {
    if (typeof window === "undefined") {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    if (typeof node.getClientRects === "function" && node.getClientRects().length > 0) {
      return true;
    }

    return (node.textContent?.trim().length ?? 0) > 0;
  });
}
