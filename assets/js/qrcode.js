/* ==========================================================================
   Tessera — qrcode.js
   --------------------------------------------------------------------------
   A complete QR Code encoder (ISO/IEC 18004), written from scratch so the
   app needs no third-party script and works offline from file://.

   Public API (attached to globalThis as QrEncoder):
       QrEncoder.encode(text, { ecc: 'L'|'M'|'Q'|'H', mask?: 0–7 })
         → { version, size, ecc, mask, mode, modules: boolean[][] }
           modules[y][x] is true for a dark module. No quiet zone included.
         Throws a RangeError (error.code = 'TOO_LONG') when the text does not
         fit even in version 40.
       QrEncoder.isFinderModule(size, x, y)
         → true inside one of the three 7×7 corner "eyes" (used for styling).
       QrEncoder.capacity(text, ecc)
         → { mode, used, max }: how much of this kind of text (digits,
           capital letters or bytes) fits at that level, and how much it uses.
       QrEncoder.MAX_CHARACTERS
         → 7089, the most characters any QR code can hold (digits, level L).

   How it works (one section each):
     data text → bit stream (mode + length + data + padding)
               → split into blocks + Reed–Solomon error correction
               → placed in the grid around the fixed patterns
               → best of 8 masks (lowest penalty score) + format/version info

   TABLE OF CONTENTS
     01  Tables (capacity per version and error-correction level)
     02  Bit buffer
     03  Encoding modes (numeric, alphanumeric, byte/UTF-8)
     04  Version selection & data codewords
     05  Reed–Solomon error correction
     06  Grid: fixed patterns
     07  Grid: format & version information
     08  Grid: data placement & masks
     09  Penalty score (mask choice)
     10  Public API
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     01  TABLES
     Index = version (1–40); index 0 is unused. Values from the standard.
     ========================================================================== */
  const MIN_VERSION = 1;
  const MAX_VERSION = 40;
  const MAX_CHARACTERS = 7089; // digits at version 40, level L — nothing longer can ever fit

  /** Error-correction codewords per block. */
  const ECC_PER_BLOCK = {
    L: [
      0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26,
      28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    M: [
      0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28,
      28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    ],
    Q: [
      0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30,
      28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    H: [
      0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
  };

  /** Number of error-correction blocks. */
  const BLOCK_COUNT = {
    L: [
      0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16,
      17, 18, 19, 19, 20, 21, 22, 24, 25,
    ],
    M: [
      0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28,
      29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
    ],
    Q: [
      0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35,
      38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
    ],
    H: [
      0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42,
      45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
    ],
  };

  /** 2-bit level code written into the format information. */
  const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /** Characters allowed in alphanumeric mode, in code order (index = value). */
  const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  /**
   * Encoding modes. `countBits` = length-field width for versions 1–9, 10–26, 27–40.
   * Listed from most to least compact; the first mode that fits the whole text is used.
   */
  const MODES = [
    { name: 'numeric', indicator: 0x1, countBits: [10, 12, 14], test: (text) => /^\d*$/.test(text) },
    {
      name: 'alphanumeric',
      indicator: 0x2,
      countBits: [9, 11, 13],
      test: (text) => /^[0-9A-Z $%*+\-./:]*$/.test(text),
    },
    { name: 'byte', indicator: 0x4, countBits: [8, 16, 16], test: () => true },
  ];

  const PAD_BYTES = [0xec, 0x11]; // alternate after the data, as the standard requires

  // Penalty weights for the mask score (section 09).
  const PENALTY_RUN = 3;
  const PENALTY_BOX = 3;
  const PENALTY_FINDER_LIKE = 40;
  const PENALTY_BALANCE = 10;

  /* ==========================================================================
     02  BIT BUFFER
     ========================================================================== */
  /**
   * Append the lowest `length` bits of `value` (most significant first).
   * @param {number[]} bits array of 0/1 values, changed in place
   */
  function appendBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  /** Bit `index` (0 = least significant) of `value` as a boolean. */
  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  /* ==========================================================================
     03  ENCODING MODES
     ========================================================================== */
  /** The most compact mode that can hold every character of `text`. */
  function chooseMode(text) {
    return MODES.find((mode) => mode.test(text));
  }

  /**
   * The data part of a segment as bits, plus its character count.
   * @returns {{ mode: object, count: number, bits: number[] }}
   */
  function makeSegment(text) {
    const mode = chooseMode(text);
    const bits = [];
    if (mode.name === 'numeric') encodeNumeric(text, bits);
    else if (mode.name === 'alphanumeric') encodeAlphanumeric(text, bits);
    else return encodeBytes(text, mode);
    return { mode, count: text.length, bits };
  }

  /** Digits in groups of 3 → 10 bits (a last group of 2 → 7 bits, of 1 → 4 bits). */
  function encodeNumeric(text, bits) {
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      appendBits(bits, Number(group), group.length * 3 + 1);
    }
  }

  /** Character pairs → 11 bits (45 × first + second); a last single character → 6 bits. */
  function encodeAlphanumeric(text, bits) {
    for (let i = 0; i < text.length; i += 2) {
      const first = ALPHANUMERIC_CHARS.indexOf(text[i]);
      if (i + 1 < text.length) appendBits(bits, first * 45 + ALPHANUMERIC_CHARS.indexOf(text[i + 1]), 11);
      else appendBits(bits, first, 6);
    }
  }

  /** Any text as UTF-8 bytes, 8 bits each (what modern phone scanners expect). */
  function encodeBytes(text, mode) {
    const bytes = new TextEncoder().encode(text);
    const bits = [];
    bytes.forEach((byte) => appendBits(bits, byte, 8));
    return { mode, count: bytes.length, bits };
  }

  /** Width of the character-count field for a mode at a version. */
  function countFieldBits(mode, version) {
    return mode.countBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];
  }

  /* ==========================================================================
     04  VERSION SELECTION & DATA CODEWORDS
     ========================================================================== */
  /** Modules available for data + error correction in a version (everything not fixed). */
  function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const alignCount = Math.floor(version / 7) + 2;
      result -= (25 * alignCount - 10) * alignCount - 55;
      if (version >= 7) result -= 36; // two 6×3 version-information areas
    }
    return result;
  }

  /** How many 8-bit data codewords fit at a version and level. */
  function dataCodewordCount(version, ecc) {
    const total = Math.floor(rawDataModules(version) / 8);
    return total - ECC_PER_BLOCK[ecc][version] * BLOCK_COUNT[ecc][version];
  }

  /** Total bits a segment needs at a version (header + data), or Infinity if the count overflows. */
  function segmentBitLength(segment, version) {
    const countBits = countFieldBits(segment.mode, version);
    if (segment.count >= 2 ** countBits) return Infinity;
    return 4 + countBits + segment.bits.length;
  }

  /**
   * Smallest version (1–40) whose capacity holds the segment.
   * @throws {RangeError} code 'TOO_LONG' when nothing fits
   */
  function chooseVersion(segment, ecc) {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
      if (segmentBitLength(segment, version) <= dataCodewordCount(version, ecc) * 8) return version;
    }
    throw tooLongError();
  }

  /** The error thrown for text that can't fit (callers check error.code). */
  function tooLongError() {
    const error = new RangeError('The text is too long for a QR code at this error-correction level');
    error.code = 'TOO_LONG';
    return error;
  }

  /** Header + data + terminator + padding, packed into bytes. */
  function buildDataCodewords(segment, version, ecc) {
    const capacityBits = dataCodewordCount(version, ecc) * 8;
    const bits = [];
    appendBits(bits, segment.mode.indicator, 4);
    appendBits(bits, segment.count, countFieldBits(segment.mode, version));
    segment.bits.forEach((bit) => bits.push(bit));
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8); // up to a byte boundary
    for (let i = 0; bits.length < capacityBits; i++) appendBits(bits, PAD_BYTES[i % 2], 8);
    return packBytes(bits);
  }

  /** 0/1 array (length a multiple of 8) → array of bytes. */
  function packBytes(bits) {
    const bytes = new Array(bits.length / 8).fill(0);
    bits.forEach((bit, i) => {
      bytes[i >>> 3] |= bit << (7 - (i & 7));
    });
    return bytes;
  }

  /* ==========================================================================
     05  REED–SOLOMON ERROR CORRECTION (GF(256), polynomial 0x11D)
     ========================================================================== */
  /** Multiply two field elements (carry-less, reduced by 0x11D). */
  function gfMultiply(x, y) {
    let product = 0;
    for (let i = 7; i >= 0; i--) {
      product = (product << 1) ^ ((product >>> 7) * 0x11d);
      product ^= ((y >>> i) & 1) * x;
    }
    return product;
  }

  /** Generator polynomial of the given degree (highest coefficient dropped; it is always 1). */
  function rsGenerator(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  /** Error-correction codewords: remainder of data ÷ generator. */
  function rsRemainder(data, generator) {
    const result = new Array(generator.length).fill(0);
    data.forEach((byte) => {
      const factor = byte ^ result.shift();
      result.push(0);
      generator.forEach((coefficient, i) => {
        result[i] ^= gfMultiply(coefficient, factor);
      });
    });
    return result;
  }

  /**
   * Split the data into blocks, add error correction to each, then interleave
   * (first byte of every block, then the second, …) as the standard requires.
   */
  function addErrorCorrection(data, version, ecc) {
    const blockCount = BLOCK_COUNT[ecc][version];
    const eccLength = ECC_PER_BLOCK[ecc][version];
    const totalCodewords = Math.floor(rawDataModules(version) / 8);
    const shortBlockCount = blockCount - (totalCodewords % blockCount);
    const shortBlockLength = Math.floor(totalCodewords / blockCount);
    const generator = rsGenerator(eccLength);
    const blocks = [];
    for (let i = 0, offset = 0; i < blockCount; i++) {
      const dataLength = shortBlockLength - eccLength + (i < shortBlockCount ? 0 : 1);
      const block = data.slice(offset, offset + dataLength);
      offset += dataLength;
      const eccBytes = rsRemainder(block, generator);
      if (i < shortBlockCount) block.push(0); // placeholder so all blocks line up; skipped below
      blocks.push(block.concat(eccBytes));
    }
    return interleave(blocks, shortBlockLength - eccLength, shortBlockCount);
  }

  /** Read the blocks column by column, skipping the short blocks' placeholder byte. */
  function interleave(blocks, placeholderIndex, shortBlockCount) {
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== placeholderIndex || j >= shortBlockCount) result.push(block[i]);
      });
    }
    return result;
  }

  /* ==========================================================================
     06  GRID: FIXED PATTERNS
     The grid object: { size, modules[y][x], isFixed[y][x] }.
     "Fixed" modules (finders, timing, alignment, format/version areas) are
     never used for data and never masked.
     ========================================================================== */
  /** Empty grid for a version. */
  function createGrid(version) {
    const size = version * 4 + 17;
    const makeRows = () => Array.from({ length: size }, () => new Array(size).fill(false));
    return { version, size, modules: makeRows(), isFixed: makeRows() };
  }

  /** Set a module and mark it as fixed. Coordinates outside the grid are ignored. */
  function setFixed(grid, x, y, dark) {
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return;
    grid.modules[y][x] = dark;
    grid.isFixed[y][x] = true;
  }

  /** Draw every pattern that doesn't depend on the data. */
  function drawFixedPatterns(grid) {
    const { size } = grid;
    for (let i = 0; i < size; i++) {
      setFixed(grid, 6, i, i % 2 === 0); // timing patterns
      setFixed(grid, i, 6, i % 2 === 0);
    }
    drawFinder(grid, 3, 3);
    drawFinder(grid, size - 4, 3);
    drawFinder(grid, 3, size - 4);
    drawAlignmentPatterns(grid);
    drawFormatBits(grid, 0); // reserve the area; real bits are written after masking
    drawVersionBits(grid);
  }

  /** 7×7 finder "eye" centred on (cx, cy), with its 1-module light separator. */
  function drawFinder(grid, cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        setFixed(grid, cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }

  /** Centre coordinates of the alignment patterns for a version (same list for x and y). */
  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos);
    return positions;
  }

  /** 5×5 alignment patterns everywhere except where they would overlap a finder. */
  function drawAlignmentPatterns(grid) {
    const positions = alignmentPositions(grid.version);
    const last = positions.length - 1;
    positions.forEach((cy, i) => {
      positions.forEach((cx, j) => {
        const overlapsFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (!overlapsFinder) drawAlignment(grid, cx, cy);
      });
    });
  }

  /** One alignment pattern: dark ring, light ring, dark centre. */
  function drawAlignment(grid, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFixed(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /* ==========================================================================
     07  GRID: FORMAT & VERSION INFORMATION
     ========================================================================== */
  /** 15-bit format word: level + mask, BCH(15,5) protected and XOR-masked. */
  function formatWord(ecc, mask) {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    return ((data << 10) | remainder) ^ 0x5412;
  }

  /** Write both copies of the format word (around the top-left finder, and split by the other two). */
  function drawFormatBits(grid, mask, ecc = 'L') {
    const bits = formatWord(ecc, mask);
    const { size } = grid;
    for (let i = 0; i <= 5; i++) setFixed(grid, 8, i, getBit(bits, i));
    setFixed(grid, 8, 7, getBit(bits, 6));
    setFixed(grid, 8, 8, getBit(bits, 7));
    setFixed(grid, 7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFixed(grid, 14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFixed(grid, size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFixed(grid, 8, size - 15 + i, getBit(bits, i));
    setFixed(grid, 8, size - 8, true); // the "dark module", always dark
  }

  /** Versions 7+ carry an 18-bit version word in two 6×3 blocks. */
  function drawVersionBits(grid) {
    const { version, size } = grid;
    if (version < 7) return;
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(grid, a, b, getBit(bits, i));
      setFixed(grid, b, a, getBit(bits, i));
    }
  }

  /* ==========================================================================
     08  GRID: DATA PLACEMENT & MASKS
     ========================================================================== */
  /**
   * Place the codewords in the zig-zag order: two-module-wide columns from the
   * right edge, going up then down, skipping fixed modules and the timing column.
   */
  function placeCodewords(grid, codewords) {
    const { size } = grid;
    const totalBits = codewords.length * 8;
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // column 6 is the vertical timing pattern
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < size; step++) {
        const y = upward ? size - 1 - step : step;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (grid.isFixed[y][x] || bitIndex >= totalBits) continue;
          grid.modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  /** The 8 mask conditions: a module is flipped when its condition is true. */
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  /** XOR a mask over the data modules. Applying the same mask twice undoes it. */
  function applyMask(grid, mask) {
    const condition = MASKS[mask];
    for (let y = 0; y < grid.size; y++) {
      for (let x = 0; x < grid.size; x++) {
        if (!grid.isFixed[y][x] && condition(x, y)) grid.modules[y][x] = !grid.modules[y][x];
      }
    }
  }

  /** Try all 8 masks and return the one with the lowest penalty. */
  function chooseBestMask(grid, ecc) {
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < MASKS.length; mask++) {
      applyMask(grid, mask);
      drawFormatBits(grid, mask, ecc);
      const score = penaltyScore(grid);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
      applyMask(grid, mask); // undo
    }
    return bestMask;
  }

  /* ==========================================================================
     09  PENALTY SCORE — lower means easier to scan. Four rules:
       1. runs of 5+ same-color modules in a row/column
       2. 2×2 boxes of one color
       3. patterns that look like a finder (1:1:3:1:1 with light space)
       4. dark/light imbalance away from 50%
     ========================================================================== */
  /** Total penalty of the current grid. */
  function penaltyScore(grid) {
    const { size, modules } = grid;
    let score = 0;
    for (let i = 0; i < size; i++) {
      score += linePenalty(size, (j) => modules[i][j]); // row i
      score += linePenalty(size, (j) => modules[j][i]); // column i
    }
    return score + boxPenalty(grid) + balancePenalty(grid);
  }

  /**
   * Rules 1 and 3 along one row or column.
   * @param {function(number): boolean} getModule module at position j of the line
   */
  function linePenalty(size, getModule) {
    const history = new Array(7).fill(0); // most recent run lengths, newest first
    let score = 0;
    let runColor = false;
    let runLength = 0;
    for (let j = 0; j < size; j++) {
      if (getModule(j) === runColor) {
        runLength++;
        if (runLength === 5) score += PENALTY_RUN;
        else if (runLength > 5) score++;
        continue;
      }
      pushRun(history, runLength, size);
      if (!runColor) score += finderLikeCount(history) * PENALTY_FINDER_LIKE;
      runColor = getModule(j);
      runLength = 1;
    }
    return score + finishLine(history, runColor, runLength, size) * PENALTY_FINDER_LIKE;
  }

  /** Record a finished run. The first run gets the light quiet zone added to it. */
  function pushRun(history, runLength, size) {
    const length = history[0] === 0 ? runLength + size : runLength;
    history.pop();
    history.unshift(length);
  }

  /** Close the line as if the light quiet zone followed, and count finder-like patterns. */
  function finishLine(history, runColor, runLength, size) {
    let length = runLength;
    if (runColor) {
      pushRun(history, length, size);
      length = 0;
    }
    pushRun(history, length + size, size);
    return finderLikeCount(history);
  }

  /** 0–2: dark 1:1:3:1:1 run pattern with ≥4 light modules on one or both sides. */
  function finderLikeCount(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  }

  /** Rule 2: every 2×2 box of a single color. */
  function boxPenalty({ size, modules }) {
    let score = 0;
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          score += PENALTY_BOX;
        }
      }
    }
    return score;
  }

  /** Rule 4: 10 points for every 5% the dark share is away from 50%. */
  function balancePenalty({ size, modules }) {
    const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    const steps = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return steps * PENALTY_BALANCE;
  }

  /* ==========================================================================
     10  PUBLIC API
     ========================================================================== */
  /**
   * Encode text as a QR code.
   * @param {string} text
   * @param {{ ecc?: 'L'|'M'|'Q'|'H', mask?: number }} [options] mask is only for testing
   * @returns {{ version:number, size:number, ecc:string, mask:number, mode:string, modules:boolean[][] }}
   */
  function encode(text, options = {}) {
    const ecc = Object.hasOwn(ECC_FORMAT_BITS, options.ecc) ? options.ecc : 'M';
    // Fail fast: a huge paste would otherwise be fully converted to bits first.
    if (String(text).length > MAX_CHARACTERS) throw tooLongError();
    const segment = makeSegment(String(text));
    const version = chooseVersion(segment, ecc);
    const codewords = addErrorCorrection(buildDataCodewords(segment, version, ecc), version, ecc);
    const grid = createGrid(version);
    drawFixedPatterns(grid);
    placeCodewords(grid, codewords);
    const forced = Number.isInteger(options.mask) && options.mask >= 0 && options.mask < MASKS.length;
    const mask = forced ? options.mask : chooseBestMask(grid, ecc);
    applyMask(grid, mask);
    drawFormatBits(grid, mask, ecc);
    return { version, size: grid.size, ecc, mask, mode: segment.mode.name, modules: grid.modules };
  }

  /** True when (x, y) lies inside one of the three 7×7 finder patterns. */
  function isFinderModule(size, x, y) {
    const nearLeft = x < 7;
    const nearTop = y < 7;
    return (nearLeft && nearTop) || (x >= size - 7 && nearTop) || (nearLeft && y >= size - 7);
  }

  /**
   * How much text of this kind fits at a level (version 40), and how much this text uses.
   * Digits and capital letters pack tighter than bytes, so the limit depends on the text.
   * @returns {{ mode: string, used: number, max: number }}
   */
  function capacity(text, ecc) {
    const value = String(text);
    const mode = chooseMode(value);
    const level = Object.hasOwn(ECC_FORMAT_BITS, ecc) ? ecc : 'M';
    const bits = dataCodewordCount(MAX_VERSION, level) * 8 - 4 - mode.countBits[2];
    const used = mode.name === 'byte' ? new TextEncoder().encode(value).length : value.length;
    return { mode: mode.name, used, max: maxCharacters(mode.name, bits) };
  }

  /** Characters that fit in `bits` data bits (see the group sizes in section 03). */
  function maxCharacters(modeName, bits) {
    if (modeName === 'numeric') {
      const rest = bits % 10;
      return Math.floor(bits / 10) * 3 + (rest >= 7 ? 2 : rest >= 4 ? 1 : 0);
    }
    if (modeName === 'alphanumeric') return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
    return Math.floor(bits / 8);
  }

  globalThis.QrEncoder = Object.freeze({ encode, isFinderModule, capacity, MAX_CHARACTERS });
})();
