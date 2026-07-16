/**
 * Brand icons for the built-in connectors.
 *
 * The SVGs are real files under assets/connectors, imported raw and inlined —
 * so swapping a logo means replacing a .svg, not editing a component, and
 * adding one is a single line in ICONS below.
 *
 * They are normalized before landing there: every id is namespaced with the
 * connector slug. Gmail, Calendar and Drive all ship id="a", and inlined side
 * by side their url(#a) gradients would resolve to whichever icon rendered
 * first — one logo would quietly wear another's colors.
 *
 * Inlining (rather than <img src>) keeps them crisp at any size and free of
 * extra requests; the files are static local assets we normalized ourselves,
 * with no <script> or external references.
 */

import github from "@/assets/connectors/github.svg?raw";
import gmail from "@/assets/connectors/gmail.svg?raw";
import notion from "@/assets/connectors/notion.svg?raw";
import googleCalendar from "@/assets/connectors/google-calendar.svg?raw";
import googleContacts from "@/assets/connectors/google-contacts.svg?raw";
import googleDrive from "@/assets/connectors/google-drive.svg?raw";
import telegram from "@/assets/connectors/telegram.svg?raw";
import yandexMail from "@/assets/connectors/yandex-mail.svg?raw";
import yandexDisk from "@/assets/connectors/yandex-disk.svg?raw";
import yandexCalendar from "@/assets/connectors/yandex-calendar.svg?raw";
import { cn } from "@/lib/utils";

/** presetId → raw SVG. Add a connector icon by adding a line. */
const ICONS: Record<string, string> = {
  github,
  notion,
  gmail,
  "google-calendar": googleCalendar,
  "google-contacts": googleContacts,
  "google-drive": googleDrive,
  telegram,
  "yandex-mail": yandexMail,
  "yandex-disk": yandexDisk,
  "yandex-calendar": yandexCalendar,
};

export function hasConnectorIcon(presetId: string): boolean {
  return presetId in ICONS;
}

export function ConnectorIcon({
  presetId,
  className,
}: {
  presetId: string;
  className?: string;
}): JSX.Element | null {
  const svg = ICONS[presetId];
  if (!svg) return null;
  return (
    <span
      role="img"
      aria-label={presetId}
      className={cn("inline-block shrink-0 [&>svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
