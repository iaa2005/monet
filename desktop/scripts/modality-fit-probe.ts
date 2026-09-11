/**
 * A chat that outlives its vision model: the pictures already in the
 * history must not reach a model that cannot see, and the model must be
 * told what it is missing. See src/main/llm/modality-fit.ts.
 */
import { fitToModalities } from "../src/main/llm/modality-fit";
import type { LLMMessage } from "../src/main/llm/adapter";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && !ok ? ` — ${JSON.stringify(detail)}` : ""}`);
};

const png = { type: "base64" as const, media_type: "image/png", data: "A".repeat(4000) };
const history: LLMMessage[] = [
  { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", source: png }] },
  { role: "assistant", content: "A cat." },
  { role: "user", content: [{ type: "document", source: { ...png, media_type: "application/pdf" }, name: "spec.pdf" }] },
  { role: "user", content: "plain string stays" },
];

const blind = fitToModalities(history, ["text"]);
const first = blind[0]!.content as Extract<LLMMessage["content"], unknown[]>;
check("image becomes a text block for a text-only model", first[1]!.type === "text");
check("the note names the kind, type and size", first[1]!.type === "text" && /image, image\/png, 3 kB/.test(first[1]!.text), first[1]);
check("the note says what the model cannot do", first[1]!.type === "text" && /cannot see images/.test(first[1]!.text));
const third = blind[2]!.content as Extract<LLMMessage["content"], unknown[]>;
check("a document carries its name", third[0]!.type === "text" && /document "spec\.pdf"/.test(third[0]!.text), third[0]);
check("text and string messages are untouched", first[0]!.type === "text" && blind[3]!.content === "plain string stays");
check("the original history is not mutated", (history[0]!.content as unknown[])[1] !== undefined && (history[0]!.content as { type: string }[])[1]!.type === "image");

const sighted = fitToModalities(history, ["text", "image", "file"]);
check("a model with every modality gets the same array back", sighted === history);

const eyesOnly = fitToModalities(history, ["text", "image"]);
check("image kept, document replaced, when only sight is there",
  (eyesOnly[0]!.content as { type: string }[])[1]!.type === "image" &&
  (eyesOnly[2]!.content as { type: string }[])[0]!.type === "text");

check("undefined modalities means text only", (fitToModalities(history, undefined)[0]!.content as { type: string }[])[1]!.type === "text");

console.log(failures ? `\n${failures} FAILED` : "\nALL MODALITY-FIT CHECKS PASSED");
process.exit(failures ? 1 : 0);
