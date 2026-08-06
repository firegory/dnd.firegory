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
