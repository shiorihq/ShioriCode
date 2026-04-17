import { hasVisibleDiffContent } from "~/lib/diffVisibility";

export function hasVisiblePullRequestDiffContent(root: ParentNode | null): boolean {
  return hasVisibleDiffContent(root);
}
