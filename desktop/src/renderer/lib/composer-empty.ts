/**
 * Is the composer visually empty — the one question the placeholder asks.
 *
 * It used to be asked in CSS: `:empty`, plus `:has(> br:only-child)` for the
 * stray `<br>` Chrome leaves behind when you delete the last character. That
 * second selector is wrong, and wrong in a way that only shows with content:
 * **`:only-child` counts ELEMENTS, not nodes**. Paste two lines and the box
 * becomes `text · <br> · text` — the `<br>` is still the only *element*
 * child, so the selector matched and the placeholder was drawn on top of the
 * text the user had just pasted.
 *
 * So the question is answered where the answer is knowable: on the
 * serialized string. A box is empty when it holds nothing, or nothing but
 * that single stray line break — which is exactly the pair of cases the two
 * old selectors were reaching for, with none of the false positives.
 */

export function isComposerEmpty(serialized: string): boolean {
  return serialized === "" || serialized === "\n";
}
