import type { GuideDocument } from "../../server/compendium/guides";

export function GuideRenderer({ document }: { document: GuideDocument }) {
  return (
    <article className="guide-document">
      <header className="compendium-hero guide-hero">
        <p className="compendium-kicker">{document.locale === "ru" ? "Путеводитель новичка" : "Beginner guide"}</p>
        <h1>{document.title}</h1>
        <p>{document.summary}</p>
      </header>
      <div className="guide-blocks">
        {document.blocks.map((block) => (
          <section key={block.id} id={block.id} className={`guide-block guide-block-${block.kind}`}>
            {block.heading ? <h2>{block.heading}</h2> : null}
            {"items" in block
              ? block.kind === "steps"
                ? <ol>{block.items.map((item, index) => <li key={`${index}-${item}`}><span aria-hidden="true">{index + 1}</span>{item}</li>)}</ol>
                : <ul>{block.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
              : <p>{block.text}</p>}
            <footer className="guide-citation">
              <span>{block.citation.attribution}</span>
              <details>
                <summary>{document.locale === "ru" ? "Показать ссылку на источник" : "Show source citation"}</summary>
                <cite><a href={block.citation.url} rel="noopener noreferrer">{block.citation.label}</a>, {block.citation.locator}</cite>
              </details>
            </footer>
          </section>
        ))}
      </div>
    </article>
  );
}
