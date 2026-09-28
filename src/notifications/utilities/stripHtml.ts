import { load } from "cheerio";

// Notification messages are authored as HTML for the in-app bell -- links,
// bold, and escapeHtml()'d entities inside that markup. A native OS push
// notification has no HTML renderer, so the raw markup would show up verbatim
// on a lock screen.
//
// cheerio rather than a tag-stripping regex because the entities have to be
// decoded too: a regex leaves "&amp;" on screen where the bell shows "&".
//
// Line and list-item breaks become spaces first: .text() joins adjacent
// blocks with nothing between them ("verified.Automatic run").
export function stripHtml(html: string | null | undefined, maxLength = 160) {
  const $ = load(String(html ?? ""));
  $("br").replaceWith(" ");
  $("li, ul").before(" ").after(" ");
  const text = $.root().text().replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
