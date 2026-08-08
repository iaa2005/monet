/**
 * What the voice is TOLD it is reading, and the picture on each voice card.
 *
 * The synthesiser does not detect language: it reads `<lang>text</lang>` and
 * that tag decides the mouth. The app used to send a constant, so the only
 * thing worth pinning is the choice — a Russian sentence with an English word
 * in it must not flip to English, and a language the model speaks must not be
 * missing from the picker.
 *
 *   npm run smoke:voicelang
 */

import {
  AUTO_LANG,
  TTS_LANGS,
  detectSpeechLang,
  isSpeechLang,
  langFlag,
  langName,
  speechLangFor,
} from "@shared/tts-langs";
import { ART_SIZE, voiceArt, voiceCells } from "@/lib/voice-art";
import { MAP_SIZE, mapCells } from "@shared/voice-map";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

// ─── The list ───────────────────────────────────────────────────────────

check("all 31 languages the model speaks", TTS_LANGS.length === 31, TTS_LANGS.length);
check(
  "every code is ISO-639-1 and unique",
  TTS_LANGS.every((l) => /^[a-z]{2}$/.test(l.code)) &&
    new Set(TTS_LANGS.map((l) => l.code)).size === 31,
);
check(
  "every one has a name and a flag",
  TTS_LANGS.every((l) => l.name.length > 2 && [...l.flag].length === 2),
  TTS_LANGS.filter((l) => [...l.flag].length !== 2),
);
check(
  "the flags are regional indicators, not letters",
  TTS_LANGS.every((l) => [...l.flag].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x1f1e6)),
);
check(
  "Russian and English come first — this app's two languages",
  TTS_LANGS[0].code === "ru" && TTS_LANGS[1].code === "en",
  TTS_LANGS.slice(0, 3).map((l) => l.code),
);
check("and the rest are alphabetical by name",
  TTS_LANGS.slice(2).every((l, i) => i === 0 || l.name.localeCompare(TTS_LANGS[i + 1].name) >= 0),
  TTS_LANGS.slice(2).map((l) => l.name),
);
check("the ones that matter here are in it", ["ru", "en", "uk", "ja", "ko"].every(isSpeechLang));
check("auto is not a language", !isSpeechLang(AUTO_LANG));
check("nor is a made-up code", !isSpeechLang("xx") && !isSpeechLang(""));
check("a name and a flag are answered for a real code", langName("ru") === "Russian" && !!langFlag("ru"));
check("and nothing is invented for a wrong one", langName("xx") === "xx" && langFlag("xx") === "");

// ─── Which language a sentence is ───────────────────────────────────────

check(
  "A RUSSIAN SENTENCE WITH AN ENGLISH WORD IS STILL RUSSIAN",
  detectSpeechLang("Проверь этот PR и запусти build, пожалуйста") === "ru",
  detectSpeechLang("Проверь этот PR и запусти build, пожалуйста"),
);
check("plain English is English", detectSpeechLang("Check the PR and run the build") === "en");
check(
  "AND THE MIRROR CASE: mostly English with a Russian word is English",
  detectSpeechLang("The build fails on Windows: смотри логи") === "en",
  detectSpeechLang("The build fails on Windows: смотри логи"),
);
check(
  "Ukrainian is not Russian — the four letters it has and Russian does not",
  detectSpeechLang("Привіт! Це моє звернення до тебе") === "uk",
  detectSpeechLang("Привіт! Це моє звернення до тебе"),
);
check("Japanese", detectSpeechLang("こんにちは、元気ですか") === "ja");
check("Korean", detectSpeechLang("안녕하세요 잘 지내세요") === "ko");
check("Greek", detectSpeechLang("Καλημέρα, τι κάνεις") === "el");
check("Arabic", detectSpeechLang("مرحبا كيف حالك") === "ar");
check("Hindi", detectSpeechLang("नमस्ते आप कैसे हैं") === "hi");
check(
  "a code fence full of latin in a Russian reply does not flip it",
  detectSpeechLang(
    "Готово. Я поправила функцию: теперь она возвращает ноль, а не падает с ошибкой на пустом вводе.",
  ) === "ru",
);
check("digits and punctuation alone fall back to English", detectSpeechLang("12:30 — 42%") === "en");
check("and so does nothing at all", detectSpeechLang("") === "en");

// ─── The setting wins over the guess ────────────────────────────────────

check("an explicit language is used as given", speechLangFor("Hello there", "ru") === "ru");
check("auto falls through to the text", speechLangFor("Привет", AUTO_LANG) === "ru");
check("so does an empty setting", speechLangFor("Привет", "") === "ru");
check("so does an absent one", speechLangFor("Привет", undefined) === "ru");
check("and so does a nonsense one — never passed through", speechLangFor("Hello", "klingon") === "en");
check(
  "the old constant is not a language and cannot survive as one",
  speechLangFor("Привет", "na") === "ru",
);

// ─── The art ────────────────────────────────────────────────────────────

// The picture comes from the VOICE where there is one — the style tensor as a
// 12×12 map (probed against the real files in smoke:tts). The id-derived
// identicon below is the fallback for a style file that cannot be read.
const REAL = "5b0894076a898ea98b92a8e744cda8b80454f7a30968b955c6c836b5ea256a6f7690669cf8910b235082a6c9b22877589c7969a7978bdb87d3458b03672767d8bf7668fdc7b089d2";
check(
  "A VOICE WITH A MAP IS DRAWN FROM ITS MAP, not its name",
  voiceCells({ id: "F1", art: REAL }).join(",") === mapCells(REAL).join(",") &&
    voiceCells({ id: "F1", art: REAL }).join(",") !== voiceArt("F1").join(","),
);
check(
  "and one without falls back to the id",
  voiceCells({ id: "F1" }).join(",") === voiceArt("F1").join(","),
);
check(
  "a map round-trips through hex",
  mapCells(REAL).length === MAP_SIZE * MAP_SIZE &&
    mapCells(REAL).every((c) => c >= 0 && c <= 15),
);
check("and the middle of the range means 'nothing to say'", mapCells("zz").every((c) => c === 8));

const F1 = voiceArt("F1");
check("the fallback is a full grid", F1.length === ART_SIZE * ART_SIZE);
check("in the same 0…15 range as a real map", F1.every((c) => c >= 0 && c <= 15));
check(
  "SAME VOICE, SAME PICTURE — twice in a row and after the others",
  JSON.stringify(voiceArt("F1")) === JSON.stringify(F1) &&
    (voiceArt("M5"), JSON.stringify(voiceArt("F1")) === JSON.stringify(F1)),
);
check(
  "mirrored down the middle",
  F1.every((c, i) => {
    const y = Math.floor(i / ART_SIZE);
    const x = i % ART_SIZE;
    return c === F1[y * ART_SIZE + (ART_SIZE - 1 - x)];
  }),
);
const ids = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5", "F-marina"];
check(
  "every voice looks different",
  new Set(ids.map((id) => voiceArt(id).join(""))).size === ids.length,
);
check(
  "and none of them is blank or solid",
  ids.every((id) => {
    const ink = voiceArt(id).filter((c) => Math.abs(c - 8) > 1).length;
    return ink > 20 && ink < ART_SIZE * ART_SIZE - 20;
  }),
  ids.map((id) => voiceArt(id).filter((c) => Math.abs(c - 8) > 1).length),
);

console.log(failures ? `\n${failures} FAILED` : "\nthe voice knows what it is reading");
process.exit(failures ? 1 : 0);
