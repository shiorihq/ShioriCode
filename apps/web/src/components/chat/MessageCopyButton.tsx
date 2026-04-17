import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  title = "Copy message",
}: {
  text: string;
  title?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={() => copyToClipboard(text)}
      title={title}
      aria-label={title}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
