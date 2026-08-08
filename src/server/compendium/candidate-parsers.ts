import {
  makeCitation,
  parseMoneyToCp,
  parseWeights,
  validateCandidateWire,
  type CandidateCitation,
  type CandidateWire,
  type EvidenceChunk,
  type ExtractionMethod,
} from "./candidate-schema.ts";
import type { CompendiumEntryType, CompendiumLanguage } from "./service.ts";
import { stableCandidateKey } from "./identity.ts";
export { stableCandidateKey } from "./identity.ts";

export type ParsedCandidate = Readonly<{ wire: CandidateWire; method: ExtractionMethod }>;

const schools: Readonly<Record<string, string>> = {
  abjuration: "abjuration", ограждение: "abjuration",
  conjuration: "conjuration", вызов: "conjuration",
  divination: "divination", прорицание: "divination",
  enchantment: "enchantment", очарование: "enchantment",
  evocation: "evocation", воплощение: "evocation",
  illusion: "illusion", иллюзия: "illusion",
  necromancy: "necromancy", некромантия: "necromancy",
  transmutation: "transmutation", преобразование: "transmutation",
};

const sizes: Readonly<Record<string, string>> = {
  tiny: "tiny", крошечный: "tiny", крошечное: "tiny", крошечная: "tiny",
  small: "small", маленький: "small", маленькое: "small", маленькая: "small",
  medium: "medium", средний: "medium", среднее: "medium", средняя: "medium",
  large: "large", большой: "large", большое: "large", большая: "large",
  huge: "huge", огромный: "huge", огромное: "huge", огромная: "huge",
  gargantuan: "gargantuan", громадный: "gargantuan", громадное: "gargantuan", громадная: "gargantuan",
};

const equipmentCategories: Readonly<Record<string, string>> = {
  "adventuring gear": "adventuring_gear", снаряжение: "adventuring_gear",
  ammunition: "ammunition", боеприпасы: "ammunition", armor: "armor", доспехи: "armor",
  focus: "focus", фокусировка: "focus", mount: "mount", "верховые животные": "mount",
  tool: "tool", инструменты: "tool", vehicle: "vehicle", транспорт: "vehicle",
  weapon: "weapon", оружие: "weapon", other: "other", прочее: "other",
};

export function parseDeterministicChunk(chunk: EvidenceChunk, language: CompendiumLanguage): readonly ParsedCandidate[] {
  return parseSpell(chunk, language)
    ?? parseCreature(chunk, language)
    ?? parseEquipmentTable(chunk, language)
    ?? parseClassProgression(chunk)
    ?? parseSpeciesHierarchy(chunk)
    ?? parseFeatureSection(chunk, language)
    ?? [];
}

export function classifyChunkType(text: string): CompendiumEntryType | null {
  if (/^(?:Casting Time|Время накладывания|Время сотворения)\s*:/im.test(text)) return "spell";
  if (/^(?:Armor Class|Класс Доспеха)\s*:?[ \t]*\d/im.test(text) && /^(?:Hit Points|Хиты)\s*:?[ \t]*\d/im.test(text)) return "creature";
  if (/\|[^\n]*(?:Cost|Стоимость)[^\n]*\|/i.test(text)) return "equipment";
  if (/\|[^\n]*(?:Level|Уровень)[^\n]*(?:Features|Умения)[^\n]*\|/i.test(text) && /(?:Hit Die|Кость хитов)\s*:/i.test(text)) return "class";
  if (/^(?:Species|Вид|Раса)(?: Variant| Вариант)?\s*$/im.test(text) && /^(?:Size|Размер)\s*:/im.test(text)) return "species";
  if (/(?:equipment|снаряжение)/iu.test(text) && /(?:cost|стоимость|цена)/iu.test(text)) return "equipment";
  if (/(?:\d+(?:st|nd|rd|th)-Level .* Feature|Умение .* \d+(?:-го|-й) уровня)/i.test(text)) return "feature";
  if (/(?:\bfeat\b|черта)/iu.test(text)) return "feat";
  if (/(?:\bbackground\b|предыстори)/iu.test(text)) return "background";
  if (/(?:magic item|магический предмет|rarity\s*:|редкость\s*:)/iu.test(text)) return "item";
  if (/(?:glossary|rules term|словар|термин правил)/iu.test(text)) return "glossary";
  return null;
}

function parseSpell(chunk: EvidenceChunk, language: CompendiumLanguage): readonly ParsedCandidate[] | null {
  const lines = meaningfulLines(chunk.quoteText);
  if (lines.length < 7) return null;
  const descriptorIndex = lines.findIndex(({ text }) => spellDescriptor(text) !== null);
  if (descriptorIndex < 1) return null;
  const descriptor = spellDescriptor(lines[descriptorIndex].text)!;
  const labels = language === "ru"
    ? {
        castingTime: /^(?:Время накладывания|Время сотворения)\s*:\s*(.+)$/i,
        range: /^(?:Дистанция|Дальность)\s*:\s*(.+)$/i,
        components: /^Компоненты\s*:\s*(.+)$/i,
        duration: /^Длительность\s*:\s*(.+)$/i,
      }
    : {
        castingTime: /^Casting Time\s*:\s*(.+)$/i,
        range: /^Range\s*:\s*(.+)$/i,
        components: /^Components\s*:\s*(.+)$/i,
        duration: /^Duration\s*:\s*(.+)$/i,
      };
  const fields = Object.fromEntries(Object.entries(labels).map(([key, regex]) => [key, findLabeledLine(lines, regex)]));
  if (Object.values(fields).some((field) => field === null)) return null;
  const typedFields = fields as Record<"castingTime" | "range" | "components" | "duration", LabeledLine>;
  const lastMetadataIndex = Math.max(descriptorIndex, ...Object.values(typedFields).map(({ index }) => index));
  const bodyLines = lines.slice(lastMetadataIndex + 1);
  if (bodyLines.length === 0) return null;
  const title = lines[descriptorIndex - 1].text;
  const body = bodyFromLines(chunk.quoteText, bodyLines);
  const attributes = {
    level: descriptor.level,
    school: descriptor.school,
    castingTime: typedFields.castingTime.value,
    range: typedFields.range.value,
    duration: typedFields.duration.value,
    components: typedFields.components.value,
    concentration: /concentration|концентрац/i.test(typedFields.duration.value),
    ritual: descriptor.ritual,
  };
  const citations = baseCitations(chunk, title, body, lines[descriptorIndex].text, Object.keys(attributes));
  for (const key of ["castingTime", "range", "duration", "components"] as const) {
    replaceCitation(citations, `$.attributes.${key}`, chunk, typedFields[key].line);
  }
  for (const key of ["level", "school", "ritual"] as const) {
    replaceCitation(citations, `$.attributes.${key}`, chunk, lines[descriptorIndex].text);
  }
  replaceCitation(citations, "$.attributes.concentration", chunk, typedFields.duration.line);
  return [validated({ entryType: "spell", candidateKey: stableCandidateKey(title), title, body, attributes, citations }, chunk, "spell-parser")];
}

function parseCreature(chunk: EvidenceChunk, language: CompendiumLanguage): readonly ParsedCandidate[] | null {
  const lines = meaningfulLines(chunk.quoteText);
  if (lines.length < 7) return null;
  const labels = language === "ru"
    ? {
        armorClass: /^Класс Доспеха\s*:?[ \t]*(\d+)/i,
        hitPoints: /^Хиты\s*:?[ \t]*(\d+)/i,
        speed: /^Скорость\s*:?[ \t]*(.+)$/i,
        challengeRating: /^(?:Опасность|Показатель опасности)\s*:?[ \t]*(1\/[248]|\d+)/i,
      }
    : {
        armorClass: /^Armor Class\s*:?[ \t]*(\d+)/i,
        hitPoints: /^Hit Points\s*:?[ \t]*(\d+)/i,
        speed: /^Speed\s*:?[ \t]*(.+)$/i,
        challengeRating: /^Challenge\s*:?[ \t]*(1\/[248]|\d+)/i,
      };
  const fields = Object.fromEntries(Object.entries(labels).map(([key, regex]) => [key, findLabeledLine(lines, regex)]));
  if (Object.values(fields).some((field) => field === null)) return null;
  const typedFields = fields as Record<"armorClass" | "hitPoints" | "speed" | "challengeRating", LabeledLine>;
  const firstStatIndex = Math.min(...Object.values(typedFields).map(({ index }) => index));
  if (firstStatIndex < 2) return null;
  const descriptor = lines[firstStatIndex - 1];
  const descriptorMatch = descriptor.text.match(/^([\p{L}]+)\s+([^,]+)(?:,\s*(.+))?$/u);
  if (!descriptorMatch) return null;
  const size = sizes[descriptorMatch[1].toLocaleLowerCase("und")];
  if (!size) return null;
  const title = lines[firstStatIndex - 2].text;
  const lastMetadataIndex = Math.max(firstStatIndex - 1, ...Object.values(typedFields).map(({ index }) => index));
  const bodyLines = lines.slice(lastMetadataIndex + 1);
  if (bodyLines.length === 0) return null;
  const body = bodyFromLines(chunk.quoteText, bodyLines);
  const attributes = {
    size,
    creatureType: descriptorMatch[2].trim(),
    alignment: descriptorMatch[3]?.trim() ?? null,
    armorClass: Number(typedFields.armorClass.value),
    hitPoints: Number(typedFields.hitPoints.value),
    challengeRating: parseFraction(typedFields.challengeRating.value),
    speed: typedFields.speed.value,
  };
  const citations = baseCitations(chunk, title, body, descriptor.text, Object.keys(attributes));
  for (const key of ["size", "creatureType", "alignment"] as const) replaceCitation(citations, `$.attributes.${key}`, chunk, descriptor.text);
  for (const key of ["armorClass", "hitPoints", "challengeRating", "speed"] as const) {
    replaceCitation(citations, `$.attributes.${key}`, chunk, typedFields[key].line);
  }
  return [validated({ entryType: "creature", candidateKey: stableCandidateKey(title), title, body, attributes, citations }, chunk, "stat-block-parser")];
}

function parseEquipmentTable(chunk: EvidenceChunk, language: CompendiumLanguage): readonly ParsedCandidate[] | null {
  const rawLines = chunk.quoteText.split("\n").map((line) => line.trim()).filter(Boolean);
  const headerIndex = rawLines.findIndex((line) => line.includes("|") && (language === "ru" ? /Стоимость/i : /Cost/i).test(line));
  if (headerIndex < 0) return null;
  const header = cells(rawLines[headerIndex]);
  const nameIndex = header.findIndex((cell) => /^(?:Name|Название|Предмет)$/i.test(cell));
  const costIndex = header.findIndex((cell) => /^(?:Cost|Стоимость|Цена)$/i.test(cell));
  const weightIndex = header.findIndex((cell) => /^(?:Weight|Вес)$/i.test(cell));
  if (nameIndex < 0 || costIndex < 0 || weightIndex < 0) return null;
  const categoryLine = rawLines.slice(0, headerIndex).reverse().find((line) => equipmentCategory(line) !== null);
  const category = categoryLine ? equipmentCategory(categoryLine) : null;
  if (!category || !categoryLine) return null;
  const candidates: ParsedCandidate[] = [];
  for (const line of rawLines.slice(headerIndex + 1)) {
    if (/^\|?\s*:?-{3}/.test(line)) continue;
    const row = cells(line);
    if (row.length !== header.length) break;
    const title = row[nameIndex];
    if (!title) continue;
    const attributes = { category, costCp: parseCost(row[costIndex]), weightLb: parseWeight(row[weightIndex]) };
    const citations = baseCitations(chunk, title, line, rawLines[headerIndex], Object.keys(attributes));
    for (const key of Object.keys(attributes)) replaceCitation(citations, `$.attributes.${key}`, chunk, line);
    replaceCitation(citations, "$.attributes.category", chunk, categoryLine);
    candidates.push(validated({ entryType: "equipment", candidateKey: stableCandidateKey(title), title, body: line, attributes, citations }, chunk, "table-parser"));
  }
  return candidates.length > 0 ? candidates : null;
}

function parseFeatureSection(chunk: EvidenceChunk, language: CompendiumLanguage): readonly ParsedCandidate[] | null {
  const lines = meaningfulLines(chunk.quoteText);
  if (lines.length < 3) return null;
  const descriptorIndex = lines.findIndex(({ text }) => language === "ru"
    ? /Умение .+ (\d+)(?:-го|-й) уровня/i.test(text)
    : /(\d+)(?:st|nd|rd|th)-Level .+ Feature/i.test(text));
  if (descriptorIndex < 1) return null;
  const levelMatch = lines[descriptorIndex].text.match(language === "ru" ? /(\d+)(?:-го|-й) уровня/i : /(\d+)(?:st|nd|rd|th)-Level/i);
  const level = Number(levelMatch?.[1]);
  if (!Number.isInteger(level) || level < 1 || level > 20) return null;
  const title = lines[descriptorIndex - 1].text;
  const bodyLines = lines.slice(descriptorIndex + 1);
  if (bodyLines.length === 0) return null;
  const body = bodyFromLines(chunk.quoteText, bodyLines);
  const attributes = { level, featureKind: lines[descriptorIndex].text };
  const citations = baseCitations(chunk, title, body, lines[descriptorIndex].text, Object.keys(attributes));
  return [validated({ entryType: "feature", candidateKey: stableCandidateKey(title), title, body, attributes, citations }, chunk, "section-parser")];
}

function parseClassProgression(chunk: EvidenceChunk): readonly ParsedCandidate[] | null {
  const lines=chunk.quoteText.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);const classIndex=lines.findIndex((line)=>/^(?:Class|Класс|Subclass|Подкласс)$/i.test(line));if(classIndex<1)return null;
  const label=(en:string,ru:string)=>findValue(lines,new RegExp(`^(?:${en}|${ru})\\s*:\\s*(.+)$`,"i"));const hit=label("Hit Die","Кость хитов")?.match(/d?(6|8|10|12)/i);const primary=label("Primary Ability","Основная характеристика");if(!hit||!primary)return null;
  const spell=label("Spellcasting Ability","Заклинательная характеристика");const parentText=label("Parent Classes","Родительские классы");
  const headerIndex=lines.findIndex((line)=>line.includes("|")&&/(?:Level|Уровень)/i.test(line)&&/(?:Features|Умения)/i.test(line));if(headerIndex<0)return null;const header=cells(lines[headerIndex]);const levelIndex=header.findIndex((cell)=>/^(?:Level|Уровень)$/i.test(cell));if(levelIndex<0)return null;
  const progressionColumns=header.filter((_,index)=>index!==levelIndex).map((heading)=>({key:stableCandidateKey(heading),heading}));const progressionRows=[] as Array<{level:number;cells:Record<string,string>}>;
  for(const line of lines.slice(headerIndex+1)){if(/^\|?\s*:?-{3}/.test(line))continue;if(!line.includes("|"))break;const row=cells(line);const level=Number(row[levelIndex]);if(!Number.isSafeInteger(level)||level<1||level>20)break;const values=row.filter((_,index)=>index!==levelIndex);progressionRows.push({level,cells:Object.fromEntries(progressionColumns.map((column,index)=>[column.key,values[index]]))});}
  if(progressionRows.length!==20||progressionRows.some((row,index)=>row.level!==index+1))return null;const title=lines[classIndex-1];const attributes={kind:/subclass|подкласс/i.test(lines[classIndex])?"subclass":"class",hitDie:Number(hit[1]),primaryAbility:primary,spellcastingAbility:spell&&!/^(?:none|нет|-|—)$/i.test(spell)?spell:null,parentClassIds:parentText?parentText.split(",").map((item)=>item.trim()):[],progressionColumns,progressionRows,features:[],crossLinks:[]};
  const citations=baseCitations(chunk,title,chunk.quoteText,lines[classIndex],Object.keys(attributes));for(const key of Object.keys(attributes))replaceCitation(citations,`$.attributes.${key}`,chunk,chunk.quoteText);
  return [validated({entryType:"class",candidateKey:stableCandidateKey(title),title,body:chunk.quoteText,attributes,citations},chunk,"table-parser")];
}

function parseSpeciesHierarchy(chunk: EvidenceChunk): readonly ParsedCandidate[] | null {
  const lines=chunk.quoteText.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);const typeIndex=lines.findIndex((line)=>/^(?:Species|Вид|Раса)(?: Variant| Вариант)?$/i.test(line));if(typeIndex<1)return null;
  const sizeText=findValue(lines,/^(?:Size|Размер)\s*:\s*(.+)$/i);const speedText=findValue(lines,/^(?:Speed|Скорость)\s*:\s*(\d+)/i);if(!sizeText||!speedText)return null;const size=sizes[sizeText.toLocaleLowerCase("und")];if(!size)return null;
  const parent=findValue(lines,/^(?:Parent Species|Родительский вид)\s*:\s*(.+)$/i);const traits=lines.filter((line)=>/^(?:Trait|Черта)\s*:/i.test(line)).map((line)=>{const parts=line.replace(/^(?:Trait|Черта)\s*:\s*/i,"").split("|").map((part)=>part.trim());return {key:stableCandidateKey(parts[0]),title:parts[1]||parts[0],body:parts[2]||parts[1],anchor:stableCandidateKey(parts[0]),...(parts[3]?{overrides:stableCandidateKey(parts[3])}:{})};});
  const title=lines[typeIndex-1];const attributes={kind:/variant|вариант/i.test(lines[typeIndex])?"variant":"species",size,speed:Number(speedText),parentSpeciesIds:parent?parent.split(",").map((item)=>item.trim()):[],traits,crossLinks:[]};const citations=baseCitations(chunk,title,chunk.quoteText,lines[typeIndex],Object.keys(attributes));for(const key of Object.keys(attributes))replaceCitation(citations,`$.attributes.${key}`,chunk,chunk.quoteText);
  return [validated({entryType:"species",candidateKey:stableCandidateKey(title),title,body:chunk.quoteText,attributes,citations},chunk,"section-parser")];
}

function findValue(lines:readonly string[],pattern:RegExp):string|null{for(const line of lines){const match=line.match(pattern);if(match?.[1]?.trim())return match[1].trim();}return null;}

function validated(wire: CandidateWire, chunk: EvidenceChunk, method: ExtractionMethod): ParsedCandidate {
  return { wire: validateCandidateWire(wire, [chunk]), method };
}

function baseCitations(chunk: EvidenceChunk, title: string, body: string, typeQuote: string, attributeKeys: readonly string[]): CandidateCitation[] {
  return [
    makeCitation(chunk, "$.entryType", typeQuote),
    makeCitation(chunk, "$.candidateKey", title),
    makeCitation(chunk, "$.title", title),
    makeCitation(chunk, "$.body", body),
    ...attributeKeys.map((key) => makeCitation(chunk, `$.attributes.${key}`, typeQuote)),
  ];
}

function replaceCitation(citations: CandidateCitation[], path: string, chunk: EvidenceChunk, quote: string): void {
  const index = citations.findIndex(({ fieldPath }) => fieldPath === path);
  citations[index] = makeCitation(chunk, path, quote);
}

type TextLine = Readonly<{ text: string; start: number; end: number }>;
type LabeledLine = Readonly<{ index: number; line: string; value: string }>;

function meaningfulLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed) {
      const start = offset + raw.indexOf(trimmed);
      lines.push({ text: trimmed, start, end: start + trimmed.length });
    }
    offset += raw.length + 1;
  }
  return lines;
}

function bodyFromLines(source: string, lines: readonly TextLine[]): string {
  return source.slice(lines[0].start, lines[lines.length - 1].end);
}

function findLabeledLine(lines: readonly TextLine[], regex: RegExp): LabeledLine | null {
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].text.match(regex);
    if (match) return { index, line: lines[index].text, value: match[1].trim() };
  }
  return null;
}

function spellDescriptor(text: string): Readonly<{ level: number; school: string; ritual: boolean }> | null {
  const lower = text.toLocaleLowerCase("und");
  const school = Object.entries(schools).find(([name]) => lower.includes(name))?.[1];
  if (!school) return null;
  const cantrip = /cantrip|заговор/i.test(text);
  const levelMatch = text.match(/([0-9])(?:st|nd|rd|th|-й|-го)?(?:\s*-?level|\s+уров)/i);
  const level = cantrip ? 0 : Number(levelMatch?.[1]);
  if (!Number.isInteger(level) || level < 0 || level > 9) return null;
  return { level, school, ritual: /ritual|ритуал/i.test(text) };
}

function cells(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function parseCost(value: string): number | null {
  return parseMoneyToCp(value)[0] ?? null;
}

function parseWeight(value: string): number | null {
  if (/^(?:-|—|нет)$/i.test(value.trim())) return null;
  return parseWeights(value)[0] ?? null;
}

function equipmentCategory(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("und");
  return Object.entries(equipmentCategories).find(([label]) => normalized.includes(label))?.[1] ?? null;
}

function parseFraction(value: string): number {
  if (!value.includes("/")) return Number(value);
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator / denominator;
}
