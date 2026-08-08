/**
 * The languages the voice speaks, and how a piece of text picks one.
 *
 * Supertonic is not multilingual by detection: the synthesiser is handed
 * `<lang>text</lang>` and THAT tag decides the mouth. The app used to send a
 * hard-coded "na" (language-agnostic) for every utterance, which reads Russian
 * with a foreign accent — audible on the first sentence. Hence a setting.
 *
 * The codes and names are the model's own list, taken from Supertone's demo
 * (huggingface.co/spaces/Supertone/supertonic-3, script.js: AVAILABLE_LANGS
 * and LANGUAGE_NAMES) rather than hand-picked, so nothing the model can speak
 * is missing from the picker. Whisper understands all 31 too, which is why
 * dictation shares this list instead of keeping its own three entries.
 *
 * The flag is a COUNTRY and the setting is a LANGUAGE — they do not map
 * one-to-one, so the pairing below is a choice: the language's principal
 * state, hence Portugal (not Brazil) for pt and Britain for en. Note that
 * Windows has no flag glyphs in Segoe UI Emoji: these render as a two-letter
 * tile there, which still reads correctly, just not colourfully.
 */

export interface SpeechLang {
  /** ISO-639-1, exactly what the synthesiser's language tag expects. */
  code: string;
  name: string;
  /** Emoji flag of the country below. */
  flag: string;
}

/** "detect it from the text", the default — never sent to the model. */
export const AUTO_LANG = "auto";

/** Language → the country whose flag stands for it. */
const COUNTRY: Record<string, string> = {
  en: "GB", ko: "KR", ja: "JP", ar: "SA", bg: "BG", cs: "CZ", da: "DK",
  de: "DE", el: "GR", es: "ES", et: "EE", fi: "FI", fr: "FR", hi: "IN",
  hr: "HR", hu: "HU", id: "ID", it: "IT", lt: "LT", lv: "LV", nl: "NL",
  pl: "PL", pt: "PT", ro: "RO", ru: "RU", sk: "SK", sl: "SI", sv: "SE",
  tr: "TR", uk: "UA", vi: "VN",
};

const NAME: Record<string, string> = {
  en: "English", ko: "Korean", ja: "Japanese", ar: "Arabic", bg: "Bulgarian",
  cs: "Czech", da: "Danish", de: "German", el: "Greek", es: "Spanish",
  et: "Estonian", fi: "Finnish", fr: "French", hi: "Hindi", hr: "Croatian",
  hu: "Hungarian", id: "Indonesian", it: "Italian", lt: "Lithuanian",
  lv: "Latvian", nl: "Dutch", pl: "Polish", pt: "Portuguese", ro: "Romanian",
  ru: "Russian", sk: "Slovak", sl: "Slovenian", sv: "Swedish", tr: "Turkish",
  uk: "Ukrainian", vi: "Vietnamese",
};

/** Two regional-indicator code points — built, not typed, so no surrogate
 * pair can be mistyped. */
function flagOf(cc: string): string {
  return String.fromCodePoint(
    ...[...cc].map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65)),
  );
}

/** Russian first, then the rest alphabetically by name: this app's user
 * speaks Russian and English, and a 31-item list should not make them hunt. */
const ORDER = ["ru", "en"];

export const TTS_LANGS: SpeechLang[] = [
  ...ORDER,
  ...Object.keys(NAME)
    .filter((c) => !ORDER.includes(c))
    .sort((a, b) => NAME[a].localeCompare(NAME[b])),
].map((code) => ({ code, name: NAME[code], flag: flagOf(COUNTRY[code]) }));

export function isSpeechLang(code: string): boolean {
  return code in NAME;
}

export function langName(code: string): string {
  return NAME[code] ?? code;
}

export function langFlag(code: string): string {
  const cc = COUNTRY[code];
  return cc ? flagOf(cc) : "";
}

/** Scripts that identify a language on their own, and what to call them. */
const SCRIPTS: { re: RegExp; lang: string }[] = [
  { re: /\p{Script=Hangul}/gu, lang: "ko" },
  // Han without kana is Chinese, which this model does not speak; Japanese
  // is the only Han-capable voice, so it gets the characters either way.
  { re: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/gu, lang: "ja" },
  { re: /\p{Script=Devanagari}/gu, lang: "hi" },
  { re: /\p{Script=Greek}/gu, lang: "el" },
  { re: /\p{Script=Arabic}/gu, lang: "ar" },
  { re: /\p{Script=Cyrillic}/gu, lang: "ru" },
  { re: /\p{Script=Latin}/gu, lang: "en" },
];

/** The four letters Ukrainian has and Russian does not — the only signal
 * this cheap that separates two languages sharing an alphabet. */
const UKRAINIAN = /[іїєґІЇЄҐ]/u;

/**
 * Which language a sentence is in, by DOMINANT script rather than first hit:
 * "Проверь этот PR" is Russian with an English word in it, and a first-match
 * rule would have the voice read the whole line in English.
 */
export function detectSpeechLang(text: string): string {
  let best = "en";
  let most = 0;
  for (const { re, lang } of SCRIPTS) {
    const n = (text.match(re) ?? []).length;
    if (n > most) {
      most = n;
      best = lang;
    }
  }
  if (best === "ru" && UKRAINIAN.test(text)) return "uk";
  return best;
}

/** The language tag for one utterance: the user's choice, or the text's own. */
export function speechLangFor(text: string, setting?: string | null): string {
  if (setting && isSpeechLang(setting)) return setting;
  return detectSpeechLang(text);
}
