import qrcode from "qrcode-generator";
import {
  IconCircleCheckOutline24 as CheckCircleIcon,
  IconCopyOutline24 as CopyIcon,
  IconQrcodeOutline24 as QrCodeIcon,
} from "nucleo-core-outline-24";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../ui/button";

/**
 * The reachable remote URL with copy + QR affordances. Shared by the setup
 * wizard's final step and the Remote settings dashboard.
 */
export function RemoteUrlCard({ url }: { url: string }) {
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const qrDataUrl = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url, "Byte");
    qr.make();
    return qr.createDataURL(7, 2);
  }, [url]);

  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  const copyUrl = useCallback(async () => {
    if (!canCopy) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }, [canCopy, url]);

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          {url}
        </code>
        <Button size="sm" variant="outline" disabled={!canCopy} onClick={() => void copyUrl()}>
          {copied ? <CheckCircleIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowQr((v) => !v)}>
          <QrCodeIcon className="size-3.5" />
          QR
        </Button>
      </div>
      {showQr ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-white p-4">
          <img
            src={qrDataUrl}
            alt="Remote access QR code"
            className="size-56 max-w-full rounded-md"
          />
          <p className="text-center text-xs text-muted-foreground">
            Scan with the iOS app to prefill Remote Server, or open it in a browser.
          </p>
        </div>
      ) : null}
    </div>
  );
}
