/**
 * Widgets: things the model can DRAW, by writing a fenced block.
 *
 * A fenced block whose language names a widget is rendered by that widget
 * instead of as code:
 *
 *     ```chart
 *     { "type": "candlestick", "title": "TSLA", "labels": [...], "series": [...] }
 *     ```
 *
 * Render only, deliberately. The widget is not a data source and there is no
 * tool behind it — the model gets its numbers however it likes (RunPython with
 * yfinance, WebFetch, a shell command) and this is how it shows them. That
 * keeps the toolset from growing every time we want a new picture, and it
 * means a widget can never fail for a reason the model has to debug.
 *
 * A block that does not parse falls back to being a code block. That is the
 * important half: a widget that silently swallows bad input is worse than no
 * widget, because the model gets no signal that it wrote something wrong and
 * the user sees an empty space where an answer should be.
 */

import { Chart, type ChartSpec } from "./Chart";

/** Renders a parsed payload, or throws/returns null if the payload is wrong. */
type Widget = (payload: unknown) => JSX.Element | null;

const WIDGETS: Record<string, Widget> = {
  chart: (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const spec = payload as ChartSpec;
    if (!Array.isArray(spec.series)) return null;
    return <Chart spec={spec} />;
  },
};

export function isWidgetLang(lang: string | undefined): boolean {
  return !!lang && lang in WIDGETS;
}

/**
 * Render a widget block, or null to let the caller fall back to code.
 * Never throws: a malformed block is the model's mistake to see, not the
 * renderer's to crash on.
 */
export function renderWidget(
  lang: string | undefined,
  source: string,
): JSX.Element | null {
  if (!lang || !(lang in WIDGETS)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    return null;
  }
  try {
    return WIDGETS[lang]!(payload);
  } catch {
    return null;
  }
}

/** The names, for the prompt that tells the model these exist. */
export const WIDGET_NAMES = Object.keys(WIDGETS);
