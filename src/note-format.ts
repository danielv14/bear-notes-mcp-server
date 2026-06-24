// Pure note-formatting logic. No side effects: parts in, strings out.
// This is the test surface for how a Bear note is structured and how a
// bear://x-callback-url is built. Execution lives behind the runner seam
// in bear.ts.

export interface NoteParts {
  title: string;
  text: string;
  tags?: string[];
}

const renderTags = (tags?: string[]): string =>
  tags?.length ? tags.map(tag => `#${tag}`).join(" ") : "";

// The single rule for structuring a note as Markdown: H1 title on the first
// line, tags on the next line, then a blank line, then the content. Putting
// the title first prevents Bear from reading a leading #tag as the title
// (regression fixed in 3e3842e, now used by both create and replace).
export const renderNoteMarkdown = ({ title, text, tags }: NoteParts): string => {
  const lines = [`# ${title}`];
  const renderedTags = renderTags(tags);
  if (renderedTags) lines.push(renderedTags);
  return `${lines.join("\n")}\n\n${text}`;
};

// Builds the full bear://x-callback-url. show_window=no is always set so Bear
// does not steal focus when a write runs (8f7ddf0 / 8424d82).
export const buildBearUrl = (action: string, params: Record<string, string>): string => {
  const allParams = { ...params, show_window: "no" };
  const query = Object.entries(allParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `bear://x-callback-url/${action}?${query}`;
};
