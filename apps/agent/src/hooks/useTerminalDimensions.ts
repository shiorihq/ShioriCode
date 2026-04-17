import { useEffect, useState } from "react";

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export function useTerminalDimensions(override?: TerminalDimensions): TerminalDimensions {
  const [dimensions, setDimensions] = useState<TerminalDimensions>(() => ({
    columns: override?.columns ?? process.stdout.columns ?? 100,
    rows: override?.rows ?? process.stdout.rows ?? 32,
  }));

  useEffect(() => {
    if (override) {
      setDimensions(override);
      return;
    }
    const handle = () => {
      setDimensions({
        columns: process.stdout.columns ?? 100,
        rows: process.stdout.rows ?? 32,
      });
    };
    process.stdout.on("resize", handle);
    return () => {
      process.stdout.off("resize", handle);
    };
  }, [override]);

  return override ?? dimensions;
}
