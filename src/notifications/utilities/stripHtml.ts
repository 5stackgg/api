import { load } from "cheerio";

// Notification messages are authored as HTML for the in-app bell -- links,
// bold, and escapeHtml()'d entities inside that markup. A native OS push
// notification has no HTML renderer, so the raw markup would show up verbatim
// on a lock screen.
//
// cheerio rather than a tag-stripping regex because the entities have to be
// decoded too: a regex leaves "&amp;" on screen where the bell shows "&".
export function stripHtml(html: string | null | undefined, maxLength = 160) {
  const text = load(String(html ?? ""))
    .root()
    .text()
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
