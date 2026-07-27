// Case-insensitive, Unicode-aware matching. Pure functions, no SQL.
//
// SQLite's LIKE, LOWER() and UPPER() only fold case for ASCII unless the
// library is built with ICU, and Bun's bundled SQLite is not. That made
// "MÖTE" fail to match "möte" while "MEETING" matched "meeting". Every
// case-insensitive comparison therefore happens here in JS instead of in SQL.

// toLowerCase() rather than toLocaleLowerCase(): the latter depends on the
// server's locale (in Turkish, "I" folds to "ı"), which would make search
// results depend on where the server runs. NFC normalization is applied so a
// precomposed "ö" and an "o" + combining diaeresis compare equal, since Bear
// stores whatever the OS input method produced.
export const foldForMatch = (value: string): string => value.normalize("NFC").toLowerCase();

// Substring match. Wildcards are not interpreted: "50%" matches the literal
// text "50%", which is the guarantee the SQL LIKE escaping used to provide.
export const containsFolded = (haystack: string, needle: string): boolean =>
  foldForMatch(haystack).includes(foldForMatch(needle));

export const equalsFolded = (left: string, right: string): boolean =>
  foldForMatch(left) === foldForMatch(right);
