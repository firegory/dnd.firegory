import Link from "next/link";

const CATEGORIES = [
  {
    title: "Классы",
    description: "Варвар, Бард, Жрец, Друид, Воин, Монах, Паладин, Следопыт, Плут, Чародей, Колдун, Волшебник",
    icon: "⚔️",
    href: "/mock/search?q=классы",
  },
  {
    title: "Заклинания",
    description: "Более 500 заклинаний с описаниями, уровнями и школами магии",
    icon: "✨",
    href: "/mock/search?q=заклинания",
  },
  {
    title: "Снаряжение",
    description: "Оружие, броня, снаряжение, магические предметы и артефакты",
    icon: "🛡️",
    href: "/mock/search?q=снаряжение",
  },
  {
    title: "Расы",
    description: "Эльфы, гномы, полуорки, тиэфлинги и другие народы D&D",
    icon: "🧝",
    href: "/mock/search?q=расы",
  },
  {
    title: "Черты",
    description: "Боевые, магические и социальные черты персонажей",
    icon: "📋",
    href: "/mock/search?q=черты",
  },
  {
    title: "Монстры",
    description: "Бестиарий с характеристиками и способностями существ",
    icon: "🐉",
    href: "/mock/search?q=монстры",
  },
];

const RECENT_SOURCES = [
  { title: "Player's Handbook 2024 (ru)", edition: "5.5e", language: "ru", chunks: 2572 },
  { title: "Monster Manual 2024 (en)", edition: "5.5e", language: "en", chunks: 1843 },
  { title: "Dungeon Master's Guide 2024 (en)", edition: "5.5e", language: "en", chunks: 1205 },
];

export default function MockHomePage() {
  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="rounded-2xl border border-border bg-gradient-to-br from-surface via-surface-light to-secondary/50 p-8 lg:p-12">
        <div className="max-w-2xl">
          <p className="mb-3 text-sm font-semibold tracking-widest text-accent uppercase">
            Citation-first D&D Search
          </p>
          <h1 className="mb-4 text-4xl font-bold leading-tight text-text-primary lg:text-5xl">
            Найди правило.<br />
            <span className="text-accent">С цитатой из источника.</span>
          </h1>
          <p className="mb-8 text-lg leading-relaxed text-text-secondary">
            Приватный поисковик по правилам D&D 5e и 5.5e с поддержкой русских
            и английских источников. Каждый результат содержит точную цитату,
            номер страницы и ссылку на источник.
          </p>

          {/* Quick search */}
          <form action="/mock/search" className="flex gap-3">
            <input
              type="text"
              name="q"
              placeholder="Как работает Sneak Attack?"
              className="flex-1 rounded-xl border border-border bg-primary/60 px-5 py-3 text-text-primary placeholder-text-muted outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="submit"
              className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90"
            >
              Искать
            </button>
          </form>
        </div>
      </section>

      {/* Categories grid */}
      <section>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">Категории</h2>
          <Link
            href="/mock/search"
            className="text-sm font-medium text-accent hover:underline"
          >
            Все категории →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.title}
              href={cat.href}
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/40 hover:bg-surface-light"
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="text-2xl">{cat.icon}</span>
                <h3 className="font-semibold text-text-primary group-hover:text-accent">
                  {cat.title}
                </h3>
              </div>
              <p className="text-sm leading-relaxed text-text-muted">
                {cat.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent sources */}
      <section>
        <h2 className="mb-6 text-xl font-bold text-text-primary">
          Последние источники
        </h2>
        <div className="space-y-3">
          {RECENT_SOURCES.map((src) => (
            <div
              key={src.title}
              className="flex items-center justify-between rounded-xl border border-border bg-surface px-5 py-4"
            >
              <div>
                <h3 className="font-semibold text-text-primary">{src.title}</h3>
                <div className="mt-1 flex gap-2">
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-medium text-accent">
                    {src.edition}
                  </span>
                  <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                    {src.language === "ru" ? "Русский" : "English"}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm text-text-muted">Чанков</p>
                <p className="font-mono text-lg font-bold text-accent">
                  {src.chunks.toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-6">
          <div className="mb-3 text-3xl">📚</div>
          <h3 className="mb-2 font-semibold text-text-primary">
            Citation-first
          </h3>
          <p className="text-sm leading-relaxed text-text-muted">
            Каждый ответ подкреплён прямой цитатой из оригинального источника с
            указанием страницы и раздела.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          <div className="mb-3 text-3xl">🌐</div>
          <h3 className="mb-2 font-semibold text-text-primary">
            Bilingual search
          </h3>
          <p className="text-sm leading-relaxed text-text-muted">
            Поиск на русском и английском с автоматическим расширением запросов
            и билингвальными алиасами.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          <div className="mb-3 text-3xl">🔒</div>
          <h3 className="mb-2 font-semibold text-text-primary">
            Private & secure
          </h3>
          <p className="text-sm leading-relaxed text-text-muted">
            Авторизация, разделение доступа и приватные коллекции. Ваши данные
            остаются вашими.
          </p>
        </div>
      </section>
    </div>
  );
}
