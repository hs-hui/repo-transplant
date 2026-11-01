/** Built from code points so this file itself holds no invisible characters. */
const range = (from: number, to: number): string =>
  `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const char = (code: number): string => String.fromCodePoint(code);

const BIDI_CONTROLS = `${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}`;
const TAG_CHARACTERS = range(0xe0000, 0xe007f);
const INVISIBLE = `${range(0x200b, 0x200d)}${char(0x2060)}${char(0xfeff)}`;

export const HIDDEN_UNICODE = new RegExp(`[${BIDI_CONTROLS}${TAG_CHARACTERS}]`, "u");
export const ZERO_WIDTH = new RegExp(`[${char(0x200b)}${char(0x2060)}]|(?<!^)${char(0xfeff)}`);

const CONTROL = "\\u0000-\\u0008\\u000B-\\u001F\\u007F";
const UNSAFE_DISPLAY = new RegExp(`[${CONTROL}${INVISIBLE}${BIDI_CONTROLS}${TAG_CHARACTERS}]`, "gu");
const HIDDEN_ONLY = new RegExp(`[${BIDI_CONTROLS}${TAG_CHARACTERS}]`, "gu");

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
