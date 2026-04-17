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

const LICENSE_TEXTS: Record<string, string> = {
  MIT: MIT_LICENSE_BODY,
  "Apache-2.0": APACHE_2_LICENSE_BODY,
};

const CREDITS: ReadonlyArray<{
  name: string;
  license: string;
  url: string;
  copyright?: string;
  fullText?: string;
}> = [
  {
    name: "t3code",
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
  {
    name: "Claude Agent SDK",
    copyright: "2025 Anthropic, PBC",
    license: "MIT",
    url: "https://github.com/anthropics/anthropic-sdk-python",
    fullText: `MIT License

Copyright (c) 2025 Anthropic, PBC

${MIT_LICENSE_BODY}`,
  },
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
