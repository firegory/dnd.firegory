import { parseSelection } from "./http.ts";
import { CompendiumReadInputError } from "./read-service.ts";
import type { OptionListOptions, OptionType, OptionVersionSelection } from "./option-read-service.ts";

export function parseOptionListOptions(type: OptionType, url: URL): OptionListOptions {
  const values = (name: string) => { const all=url.searchParams.getAll(name); if(all.length>1) throw new CompendiumReadInputError(`${name} may only be provided once.`); return all[0]?.normalize("NFC").trim()||undefined; };
  const kind=values("kind"); const query=values("q"); const limit=values("limit");
  if(kind && !(type === "class" ? ["class","subclass"] : ["species","variant"]).includes(kind)) throw new CompendiumReadInputError("Invalid option kind.");
  if(limit && !/^\d+$/.test(limit)) throw new CompendiumReadInputError("Invalid option limit.");
  return { ...parseSelection(url), ...(kind?{kind:kind as OptionListOptions["kind"]}:{}), ...(query?{query}:{}), ...(limit?{limit:Number(limit)}:{}) };
}

export function parseOptionVersionSelection(url: URL): OptionVersionSelection {
  const sourceId=url.searchParams.get("sourceId")?.trim();const revisionId=url.searchParams.get("revisionId")?.trim();
  if(url.searchParams.getAll("sourceId").length>1||url.searchParams.getAll("revisionId").length>1)throw new CompendiumReadInputError("Version selectors may only be provided once.");
  return {...parseSelection(url),...(sourceId?{sourceId}:{}),...(revisionId?{revisionId}:{})};
}
