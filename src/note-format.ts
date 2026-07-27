// Pure note-formatting logic. No side effects: parts in, strings out.
// This is the test surface for how a Bear note is structured and how a
// bear://x-callback-url is built. Execution lives behind the runner seam
// in bear.ts.

export interface NoteParts {
  title: string;
  text: string;
  tags?: string[];
}

// Strips Bear's `#` markers and surrounding whitespace from a tag the caller
// supplied, so "#work", " work ", "work" and Bear's own multiword form
// "#my tag#" all name the same tag. Returns undefined when nothing usable is
// left ("", "#", "   "), which callers treat as "no tag" rather than as a tag
// named "".
//
// Shared by both paths on purpose: the write path renders the result, the read
// path matches it against ZSFNOTETAG.ZTITLE, which stores tags without any `#`.
export const normalizeTagName = (tag: string): string | undefined => {
  const withoutLeading = tag.trim().replace(/^#+/, "").trim();
  // The closing hash only exists to terminate a multiword tag, so strip it
  // only when there is whitespace. Otherwise "c#" and "f#" would quietly lose
  // a character that is part of the name.
  const cleaned = /\s/.test(withoutLeading)
    ? withoutLeading.replace(/#+$/, "").trim()
    : withoutLeading;
  return cleaned || undefined;
};

// Renders one tag in Bear's syntax. A tag containing whitespace needs a
// closing hash (`#my tag#`) or Bear terminates it at the first space and
// leaves the rest sitting in the note body as plain text. Nested tags use `/`
// and are left alone. A tag that normalizes to nothing is dropped.
const renderTag = (tag: string): string | undefined => {
  const name = normalizeTagName(tag);
  if (!name) return undefined;
  return /\s/.test(name) ? `#${name}#` : `#${name}`;
};

const renderTags = (tags?: string[]): string =>
  (tags ?? [])
    .map(renderTag)
    .filter((tag): tag is string => tag !== undefined)
    .join(" ");

// The single rule for structuring a note as Markdown: H1 title on the first
// line, tags on the next line, then a blank line, then the content. Putting
// the title first prevents Bear from reading a leading #tag as the title
// (regression fixed in 3e3842e, now used by both create and replace).
//
// A blank title is rejected rather than rendered as a bare "# " heading: with
// mode=replace_all that empty heading would overwrite the note's real title.
// The tool schemas reject it at the boundary; this is the backstop for any
// other caller, and keeps the H1-first guarantee unconditional.
export const renderNoteMarkdown = ({ title, text, tags }: NoteParts): string => {
  if (!title.trim()) {
    throw new Error("Note title must not be empty");
  }
  const lines = [`# ${title}`];
  const renderedTags = renderTags(tags);
  if (renderedTags) lines.push(renderedTags);
  return `${lines.join("\n")}\n\n${text}`;
};

// Builds the full bear://x-callback-url. show_window=no is always set so Bear
// does not steal focus when a write runs (8f7ddf0 / 8424d82); it is an
// optional parameter on every action this server sends.
export const buildBearUrl = (action: string, params: Record<string, string>): string => {
  const allParams = { ...params, show_window: "no" };
  const query = Object.entries(allParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `bear://x-callback-url/${action}?${query}`;
};
