const plannedFeatures = [
  "Private login-protected D&D rules search",
  "Edition and language aware retrieval",
  "Citation-first answers with source quotes",
];

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero-card" aria-labelledby="page-title">
        <p className="eyebrow">Repository bootstrap</p>
        <h1 id="page-title">dnd.firegory</h1>
        <p className="lede">
          Initial Next.js + TypeScript skeleton for a private D&D 5e/5.5e
          search and citation-first RAG app.
        </p>
        <ul>
          {plannedFeatures.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
