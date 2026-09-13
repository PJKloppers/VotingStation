/**
 * Code 128, subset C: the PIN as a row of bars.
 *
 * Subset C reads the digits in pairs -- one symbol carries two of them -- so a
 * six-digit PIN is three data symbols rather than six. That matters on a slip,
 * where the barcode's width is the scarce thing: fewer symbols means wider
 * bars in the same space, and the width of the narrowest bar is what decides
 * whether a scanner reads it at all.
 *
 * Every symbol is six alternating runs, bar first, eleven modules in all. The
 * stop symbol is the exception: seven runs and thirteen modules, the extra bar
 * being what lets a scanner read the symbol backwards and know that it did.
 *
 * The encoder here is ours; the tests decode what it draws with ZXing, which
 * is somebody else's, so a mistake in this table shows up as a barcode that
 * does not read rather than as a test that agrees with the bug.
 */

/**
 * The run lengths for symbol values 0-106, bar first.
 *
 * 0-102 are the data values, 103-105 the three start symbols, 106 the stop.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131',
  '211412',  // 103, start in subset A
  '211214',  // 104, start in subset B
  '211232',  // 105, start in subset C
  '2331112', // 106, stop
];

const START_C = 105;
const STOP = 106;

/**
 * The quiet zone, in modules, each side.
 *
 * Ten is the standard's minimum for Code 128. A barcode printed without one is
 * the commonest reason a scanner sees nothing at all, and on a slip the
 * neighbouring text is right there, so it is drawn as part of the symbol
 * rather than left to whatever the layout happens to give.
 */
export const BAR_QUIET = 10;

export interface Barcode {
  /** Run lengths in modules, bar first, alternating bar and space. */
  runs: number[];
  /** Total width in modules, the quiet zones included. */
  width: number;
  /** What it encodes, for a caller that wants to print it underneath. */
  text: string;
}

/**
 * The barcode for a string of digits, or null if it is not one.
 *
 * Subset C takes digits two at a time, so an odd number of them cannot be
 * encoded this way; the caller is asked for an even-length digit string rather
 * than being given a silently different symbol.
 */
export function encodeBarcode(digits: string): Barcode | null {
  if (!/^\d+$/.test(digits) || digits.length % 2 !== 0) return null;

  const values = [START_C];
  for (let i = 0; i < digits.length; i += 2) values.push(Number(digits.slice(i, i + 2)));

  // The check symbol: the start value, plus each data value times its position,
  // modulo 103. The start symbol counts as position zero and so is not weighted.
  let sum = START_C;
  for (let i = 1; i < values.length; i++) sum += values[i]! * i;
  values.push(sum % 103, STOP);

  const runs: number[] = [BAR_QUIET];   // leading quiet zone, a space
  for (const v of values) {
    for (const run of PATTERNS[v]!) runs.push(Number(run));
  }
  runs.push(BAR_QUIET);

  // The runs alternate from the first bar, but the list opens with a space, so
  // an even index is a space and an odd one a bar.
  return {
    runs,
    width: runs.reduce((a, b) => a + b, 0),
    text: digits,
  };
}

/** The dark runs as one SVG path, a full-height rectangle each. */
export function barcodePath(code: Barcode, height: number): string {
  let x = 0;
  let d = '';
  code.runs.forEach((run, i) => {
    // odd index is a bar; see the note in encodeBarcode
    if (i % 2 === 1) d += `M${x} 0h${run}v${height}h-${run}z`;
    x += run;
  });
  return d;
}
