import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent } from "../ui/collapsible";

const MIT_LICENSE_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const APACHE_2_LICENSE_BODY = `Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.`;

const ISC_LICENSE_BODY = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const LICENSE_TEXTS: Record<string, string> = {
  MIT: MIT_LICENSE_BODY,
  "Apache-2.0": APACHE_2_LICENSE_BODY,
  ISC: ISC_LICENSE_BODY,
};

const CREDITS: ReadonlyArray<{
  name: string;
  license: string;
  url: string;
  copyright?: string;
  fullText?: string;
}> = [
  {
    name: "T3Code",
    copyright: "2026 T3 Tools Inc.",
    license: "MIT",
    url: "https://github.com/pingdotgg/t3code",
    fullText: `MIT License

Copyright (c) 2026 T3 Tools Inc.

${MIT_LICENSE_BODY}`,
  },
  {
    name: "Codex",
    copyright: "2025 OpenAI",
    license: "Apache-2.0",
    url: "https://github.com/openai/codex",
  },
  // Core framework
  { name: "React", license: "MIT", url: "https://github.com/facebook/react" },
  { name: "React DOM", license: "MIT", url: "https://github.com/facebook/react" },
  { name: "Vite", license: "MIT", url: "https://github.com/vitejs/vite" },
  { name: "Electron", license: "MIT", url: "https://github.com/electron/electron" },
  {
    name: "electron-updater",
    license: "MIT",
    url: "https://github.com/electron-userland/electron-builder",
  },

  // Effect ecosystem
  { name: "Effect", license: "MIT", url: "https://github.com/Effect-TS/effect" },
  { name: "@effect/platform-bun", license: "MIT", url: "https://github.com/Effect-TS/effect" },
  { name: "@effect/platform-node", license: "MIT", url: "https://github.com/Effect-TS/effect" },
  { name: "@effect/sql-sqlite-bun", license: "MIT", url: "https://github.com/Effect-TS/effect" },
  { name: "@effect/atom-react", license: "MIT", url: "https://github.com/Effect-TS/effect" },

  // Routing & data
  { name: "TanStack Router", license: "MIT", url: "https://github.com/TanStack/router" },
  { name: "TanStack Query", license: "MIT", url: "https://github.com/TanStack/query" },
  { name: "TanStack Virtual", license: "MIT", url: "https://github.com/TanStack/virtual" },
  { name: "TanStack Pacer", license: "MIT", url: "https://github.com/TanStack/pacer" },
  { name: "Zustand", license: "MIT", url: "https://github.com/pmndrs/zustand" },
  { name: "Convex", license: "Apache-2.0", url: "https://github.com/get-convex/convex-js" },
  {
    name: "@convex-dev/auth",
    license: "Apache-2.0",
    url: "https://github.com/get-convex/convex-auth",
  },
  { name: "@auth/core", license: "ISC", url: "https://github.com/nextauthjs/next-auth" },

  // UI
  { name: "Base UI", license: "MIT", url: "https://github.com/mui/base-ui" },
  { name: "Lucide", license: "ISC", url: "https://github.com/lucide-icons/lucide" },
  { name: "Tailwind CSS", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "tailwind-merge", license: "MIT", url: "https://github.com/dcastil/tailwind-merge" },
  {
    name: "class-variance-authority",
    license: "Apache-2.0",
    url: "https://github.com/joe-bell/cva",
  },
  { name: "tw-shimmer", license: "MIT", url: "https://github.com/assistant-ui/tw-shimmer" },
  { name: "AutoAnimate", license: "MIT", url: "https://github.com/formkit/auto-animate" },

  // Editor & terminal
  { name: "Lexical", license: "MIT", url: "https://github.com/facebook/lexical" },
  { name: "@lexical/react", license: "MIT", url: "https://github.com/facebook/lexical" },
  { name: "xterm.js", license: "MIT", url: "https://github.com/xtermjs/xterm.js" },
  { name: "@xterm/addon-fit", license: "MIT", url: "https://github.com/xtermjs/xterm.js" },

  // Drag & drop
  { name: "dnd kit", license: "MIT", url: "https://github.com/clauderic/dnd-kit" },

  // Markdown
  { name: "react-markdown", license: "MIT", url: "https://github.com/remarkjs/react-markdown" },
  { name: "remark-gfm", license: "MIT", url: "https://github.com/remarkjs/remark-gfm" },

  // Diffs
  { name: "@pierre/diffs", license: "MIT", url: "https://github.com/pierre-co/diffs" },

  // AI SDKs
  { name: "Vercel AI SDK", license: "Apache-2.0", url: "https://github.com/vercel/ai" },
  {
    name: "Claude Agent SDK",
    license: "MIT",
    url: "https://github.com/anthropics/anthropic-sdk-python",
  },

  // Server utilities
  { name: "node-pty", license: "MIT", url: "https://github.com/microsoft/node-pty" },
  { name: "open", license: "MIT", url: "https://github.com/sindresorhus/open" },
];

const linkClasses =
  "underline decoration-muted-foreground/30 underline-offset-2 transition-colors hover:text-foreground";

const cardClasses =
  "relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

export function CreditsPanel() {
  const [expandedLicenses, setExpandedLicenses] = useState<Set<string>>(new Set());

  function toggleLicense(key: string) {
    setExpandedLicenses((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="space-y-3">
          <h2 className="text-[11px] font-medium text-muted-foreground">Credits / Licenses</h2>
          <div className={cardClasses}>
            {CREDITS.map((entry, i) => {
              const displayText = entry.fullText ?? LICENSE_TEXTS[entry.license];
              const isOpen = expandedLicenses.has(entry.name);
              return (
                <div key={entry.name} className={i > 0 ? "border-t border-border" : ""}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left sm:px-5"
                    onClick={() => toggleLicense(entry.name)}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-sm text-foreground">{entry.name}</span>
                      {entry.copyright ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          &copy; {entry.copyright}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {entry.license}
                    </span>
                    <ChevronDownIcon
                      className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  <Collapsible open={isOpen}>
                    <CollapsibleContent>
                      <div className="border-t border-border/50 px-4 py-3 sm:px-5">
                        <div className="flex items-center gap-2 pb-2">
                          <a
                            href={entry.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`text-xs text-muted-foreground ${linkClasses}`}
                          >
                            View on GitHub
                          </a>
                        </div>
                        {displayText ? (
                          <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                            {displayText}
                          </pre>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">
                            See repository for full license text.
                          </p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
