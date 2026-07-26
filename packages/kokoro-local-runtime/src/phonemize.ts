/*
 * Adapted and modified from kokoro-js 1.2.1 at commit
 * 664c76a704021239ba59c84dcbaa4d3dece01fe9 (src/phonemize.js).
 * The original and this adapted file are licensed under Apache-2.0; see
 * LICENSE-APACHE-2.0 and THIRD_PARTY_NOTICES. Changes are limited to TypeScript
 * types and exporting normalization for package tests.
 */

import { phonemize as espeakng } from "phonemizer"

function split(text: string, regex: RegExp): { match: boolean; text: string }[] {
  const result: { match: boolean; text: string }[] = []
  let previous = 0
  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0]
    if (previous < match.index) result.push({ match: false, text: text.slice(previous, match.index) })
    if (fullMatch.length > 0) result.push({ match: true, text: fullMatch })
    previous = match.index + fullMatch.length
  }
  if (previous < text.length) result.push({ match: false, text: text.slice(previous) })
  return result
}

function splitNumber(match: string): string {
  if (match.includes(".")) return match
  if (match.includes(":")) {
    const [hours, minutes] = match.split(":").map(Number)
    if (minutes === 0) return `${hours} o'clock`
    if (minutes! < 10) return `${hours} oh ${minutes}`
    return `${hours} ${minutes}`
  }
  const year = Number.parseInt(match.slice(0, 4), 10)
  if (year < 1100 || year % 1000 < 10) return match
  const left = match.slice(0, 2)
  const right = Number.parseInt(match.slice(2, 4), 10)
  const suffix = match.endsWith("s") ? "s" : ""
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`
    if (right < 10) return `${left} oh ${right}${suffix}`
  }
  return `${left} ${right}${suffix}`
}

function flipMoney(match: string): string {
  const bill = match[0] === "$" ? "dollar" : "pound"
  if (Number.isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`
  if (!match.includes(".")) return `${match.slice(1)} ${bill}${match.slice(1) === "1" ? "" : "s"}`
  const [whole, cents = ""] = match.slice(1).split(".")
  const amount = Number.parseInt(cents.padEnd(2, "0"), 10)
  const coins = match[0] === "$" ? (amount === 1 ? "cent" : "cents") : amount === 1 ? "penny" : "pence"
  return `${whole} ${bill}${whole === "1" ? "" : "s"} and ${amount} ${coins}`
}

function pointNumber(match: string): string {
  const [whole, fraction = ""] = match.split(".")
  return `${whole} point ${fraction.split("").join(" ")}`
}

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, "\"")
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNumber)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]'
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`, "g")

export async function phonemize(text: string, language: "a" | "b" = "a", normalize = true): Promise<string> {
  if (normalize) text = normalizeText(text)
  const sections = split(text, PUNCTUATION_PATTERN)
  const locale = language === "a" ? "en-us" : "en"
  const phonemes = (await Promise.all(sections.map(async (section) =>
    section.match ? section.text : (await espeakng(section.text, locale)).join(" "),
  ))).join("")

  let processed = phonemes
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z")
  if (language === "a") processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di")
  return processed.trim()
}
