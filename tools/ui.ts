/** Tiny ANSI helpers so the tools stay dependency-free (chalk 5 is ESM-only). */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ESC = "\u001b[";
const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

export const OK = green("ok");
export const MISSING = red("missing");
export const EMPTY = yellow("empty");
