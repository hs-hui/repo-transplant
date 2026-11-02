/** Built from code points so this file itself holds no invisible characters. */
const range = (from: number, to: number): string =>
  `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const char = (code: number): string => String.fromCodePoint(code);

const BIDI_CONTROLS = `${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}`;
const TAG_CHARACTERS = range(0xe0000, 0xe007f);
const SUPPLEMENT_SELECTORS = range(0xe0100, 0xe01ef);
/** Japanese and Chinese text uses one of these selectors after an ideograph. Anywhere else they only hide data. */
const IDEOGRAPHS = `${range(0x3400, 0x9fff)}${range(0xf900, 0xfaff)}${range(0x20000, 0x3ffff)}`;
const STRAY_SELECTOR = `(?<![${IDEOGRAPHS}])[${SUPPLEMENT_SELECTORS}]|[${SUPPLEMENT_SELECTORS}]{2}`;

const HIDDEN_UNICODE = new RegExp(`[${BIDI_CONTROLS}${TAG_CHARACTERS}]|${STRAY_SELECTOR}`, "u");
/** The England, Scotland and Wales flags are written in tag characters. */
const FLAGS = new RegExp(
  ["gbeng", "gbsct", "gbwls"]
    .map(
      (code) =>
        `${char(0x1f3f4)}${[...code].map((letter) => char(0xe0000 + letter.charCodeAt(0))).join("")}${char(0xe007f)}`,
    )
    .join("|"),
  "gu",
);

export const hasHiddenUnicode = (line: string): boolean => HIDDEN_UNICODE.test(line.replace(FLAGS, ""));
export const ZERO_WIDTH = new RegExp(`[${char(0x200b)}${char(0x2060)}]|(?<!^)${char(0xfeff)}`);

const IGNORABLE = "\\p{Default_Ignorable_Code_Point}";
const CONTROL = "\\u0000-\\u0008\\u000B-\\u001F\\u007F";
// Emoji, Persian and ideographs need these, so readable text keeps them. Nothing here forges anything.
const WANTED = `[${char(0x200c)}${char(0x200d)}${range(0xfe00, 0xfe0f)}]|(?<=[${IDEOGRAPHS}])[${SUPPLEMENT_SELECTORS}](?![${SUPPLEMENT_SELECTORS}])`;
const UNSAFE_DISPLAY = new RegExp(`[${CONTROL}]|(?!${WANTED})${IGNORABLE}`, "gu");
// A leading byte order mark is ordinary.
const HIDDEN_ONLY = new RegExp(`(?!${WANTED})(?!^${char(0xfeff)})${IGNORABLE}`, "gu");
const ANY_IGNORABLE = new RegExp(IGNORABLE, "gu");

/** Text as a reader sees it, so an invisible character inside a phrase cannot break a pattern. */
export const withoutIgnorable = (text: string): string => text.replace(ANY_IGNORABLE, "");

/** Replaces characters that could hide text from a reader or forge terminal output. */
export const sanitizeDisplay = (text: string): string => text.replace(UNSAFE_DISPLAY, "�");

/** Keeps a file readable while making its hidden characters visible to whoever reads it. */
export const revealHidden = (text: string): string =>
  text.replace(
    HIDDEN_ONLY,
    (found) => `[U+${found.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`,
  );

/** Turns offsets into line numbers in O(log n), for text that may hold many matches. */
export function lineLocator(text: string): (index: number) => number {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");
