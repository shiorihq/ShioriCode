import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { executeShioriWebSearch, parseDuckDuckGoHtmlSearchResults } from "./shioriWebSearch.ts";

const SAMPLE_DUCKDUCKGO_HTML = `
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a
          rel="nofollow"
          class="result__a"
          href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc"
        >
          How to Treat Chickenpox | Chickenpox (Varicella) | CDC
        </a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc">
            www.cdc.gov/chickenpox/treatment/index.html
          </a>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc">
        The best way to prevent <b>chickenpox</b> is to get the <b>chickenpox</b> vaccine.
      </a>
      <div class="clear"></div>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a
          rel="nofollow"
          class="result__a"
          href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmy.clevelandclinic.org%2Fhealth%2Fdiseases%2F4017%2Dchickenpox&amp;rut=def"
        >
          Chickenpox: Causes, Symptoms, Treatment &amp; Prevention
        </a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmy.clevelandclinic.org%2Fhealth%2Fdiseases%2F4017%2Dchickenpox&amp;rut=def">
        Learn about <b>chickenpox</b>, a contagious infection that causes a blister-like rash.
      </a>
      <div class="clear"></div>
    </div>
  </div>
`;

describe("parseDuckDuckGoHtmlSearchResults", () => {
  it("extracts normalized titles, links, snippets, and display URLs", () => {
    const results = parseDuckDuckGoHtmlSearchResults(SAMPLE_DUCKDUCKGO_HTML, 5);

    assert.deepStrictEqual(results, [
      {
        title: "How to Treat Chickenpox | Chickenpox (Varicella) | CDC",
        url: "https://www.cdc.gov/chickenpox/treatment/index.html",
        snippet: "The best way to prevent chickenpox is to get the chickenpox vaccine.",
        displayUrl: "www.cdc.gov/chickenpox/treatment/index.html",
      },
      {
        title: "Chickenpox: Causes, Symptoms, Treatment & Prevention",
        url: "https://my.clevelandclinic.org/health/diseases/4017-chickenpox",
        snippet: "Learn about chickenpox, a contagious infection that causes a blister-like rash.",
        displayUrl: "my.clevelandclinic.org/health/diseases/4017-chickenpox",
      },
    ]);
  });
});

describe("executeShioriWebSearch", () => {
  it("returns parsed web results for a query", async () => {
    const response = await executeShioriWebSearch({
      toolInput: {
        query: "chicken pox treatment",
        max_results: 1,
      },
      fetchImpl: async () => new Response(SAMPLE_DUCKDUCKGO_HTML, { status: 200 }),
    });

    assert.equal(response.query, "chicken pox treatment");
    assert.equal(response.provider, "duckduckgo");
    assert.deepStrictEqual(response.results, [
      {
        title: "How to Treat Chickenpox | Chickenpox (Varicella) | CDC",
        url: "https://www.cdc.gov/chickenpox/treatment/index.html",
        snippet: "The best way to prevent chickenpox is to get the chickenpox vaccine.",
        displayUrl: "www.cdc.gov/chickenpox/treatment/index.html",
      },
    ]);
  });

  it("rejects empty queries before making a network request", async () => {
    await assert.rejects(
      () =>
        executeShioriWebSearch({
          toolInput: { query: "   " },
          fetchImpl: async () => new Response(SAMPLE_DUCKDUCKGO_HTML, { status: 200 }),
        }),
      /non-empty query/,
    );
  });
});
