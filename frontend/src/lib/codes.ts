/**
 * Reading either code on a slip, out of a camera frame.
 *
 * A slip carries two: the square one, which holds the ballot's address and the
 * PIN only if the organizer chose to print it that way, and the barcode, which
 * holds the PIN and nothing else. Anything pointed at a slip wants both, so the
 * knowing-how lives here and the components only decide what to do with what
 * comes back.
 *
 * Nothing here is imported at the top of the app. Both decoders are loaded by
 * the call below, which the components make once the camera is being asked for
 * -- so a page that never opens one pays for neither. The barcode reader is the
 * larger by far.
 */

/** Reads one frame. Returns whatever a code in it says, or null. */
export type CodeReader = (pixels: ImageData) => string | null;

/**
 * Loads the two decoders and returns a reader over both.
 *
 * The square code is tried first: it is the cheaper of the two by a wide
 * margin, and on a frame holding neither it is most of the cost.
 */
export async function loadCodeReader(): Promise<CodeReader> {
  const [{ default: jsQR }, zxing] = await Promise.all([
    import('jsqr'),
    import('@zxing/library'),
  ]);
  const {
    MultiFormatOneDReader, BinaryBitmap, HybridBinarizer, GlobalHistogramBinarizer,
    RGBLuminanceSource, DecodeHintType, BarcodeFormat,
  } = zxing;

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
  const oneD = new MultiFormatOneDReader(hints);

  return (pixels) => {
    const square = jsQR(pixels.data, pixels.width, pixels.height,
                        { inversionAttempts: 'dontInvert' });
    if (square) return square.data;

    // One luminance byte a pixel: given a Uint8ClampedArray, ZXing takes the
    // values as already computed rather than as RGBA.
    const w = pixels.width;
    const h = pixels.height;
    const lum = new Uint8ClampedArray(w * h);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = (pixels.data[i * 4]! * 306 + pixels.data[i * 4 + 1]! * 601
                + pixels.data[i * 4 + 2]! * 117) >> 10;
    }

    /*
     * Upright and on its side, each through both binarizers.
     *
     * The turn is not optional: the barcode is printed standing up the slip,
     * ZXing's luminance source reports no rotation support so it will not try
     * the other way round on its own, and somebody holding a slip up to a
     * camera holds it whichever way it came off the pile.
     *
     * Which binarizer copes is a property of the light rather than of the code
     * -- the block-local one handles a slip lit unevenly, the global one a flat
     * field where the other finds edges that are not there.
     *
     * Each attempt after the first runs only because the one before found
     * nothing, which on a frame with no barcode in it -- most frames -- is a
     * few more passes over pixels already in cache.
     */
    const turned = new Uint8ClampedArray(lum.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) turned[x * h + (h - 1 - y)] = lum[y * w + x]!;
    }

    for (const [px, pw, ph] of [[lum, w, h], [turned, h, w]] as const) {
      for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
        try {
          const bitmap = new BinaryBitmap(new Binarizer(
            new RGBLuminanceSource(px, pw, ph)));
          return oneD.decode(bitmap, hints).getText();
        } catch {
          // not this way up, or not with this threshold
        }
      }
    }
    return null;
  };
}
