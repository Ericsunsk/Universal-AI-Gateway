#!/usr/bin/env node
/**
 * decode-trae.js — deobfuscator for the Trae (formerly MarsCode) VS Code extension bundle.
 *
 * The `MarsCode.marscode-extension` (display name "TraeCode: Coding Assistant") ships a
 * `dist/extension.js` that is protected by `javascript-obfuscator` (string-array encoding +
 * hex-literal call sites, no content-level encryption). This tool defeats it:
 *
 *   1. Extract the global string array `_0x4eea32` (29,351 entries) with a string-aware parser
 *      (naive bracket matching breaks because the array literal contains `[`/`]` inside strings).
 *   2. Recover the self-defending left-rotation count C by simulating the file-head checksum loop
 *      (`parseInt` terms must sum to 0x811fd). C=335 for v1.7.9; recomputed automatically here.
 *   3. Decode any `_0x…(0xHEX)` call site: `array[0xHEX - 0x18f]` on the C-rotated array.
 *
 * Usage:
 *   node scripts/decode-trae.js <extension.js> strings        # dump full string table
 *   node scripts/decode-trae.js <extension.js> decode 0xf8d   # decode one hex arg
 *   node scripts/decode-trae.js <extension.js> endpoints      # list endpoint/path strings
 *   node scripts/decode-trae.js <extension.js> scan <regex>   # list strings matching regex
 *
 * Reference: .claude/skills/ai-gateway/references/trae.md (see skills/ai-gateway in ~/.claude).
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants recovered from the bundle's shape (v1.7.9). These are auto-derived
// where possible, but the array variable name and decode offset are stable.
// ---------------------------------------------------------------------------
// Per-bundle profile: string-array variable name, factory function, decode offset,
// plus the self-defending rotate-loop expression (checksum + terms) used to recover C.
// Terms are applied as: sum += sign * (parseInt(array[arg - offset]) / div).
const PROFILES = {
  extension: {
    arrayVar: "_0x4eea32", factory: "_0x386b", offset: 0x18f, checksum: 0x811fd,
    terms: [
      { arg: 0x45c, sign: -1, div: 1 },
      { arg: 0x3a8c, sign: +1, div: 2 },
      { arg: 0x5c48, sign: -1, div: 3 },
      { arg: 0x4127, sign: -1, div: 4 },
      { arg: 0x68be, sign: +1, div: 5 },
      { arg: 0x37ee, sign: +1, div: 6 },
      { arg: 0xbaf, sign: +1, div: 7 },
    ],
  },
  aiServer: {
    arrayVar: "_0x2b0a37", factory: "_0x22db", offset: 0x1eb, checksum: 0x3cfb0,
    // The aiServer rotate loop is a multiply-nested product, encoded here as a single
    // "product" term list: parse each arg then multiply their signs/divisions. We model it
    // as one compound term by folding all factors into sign/div of the FIRST entry and a
    // product list. For clarity we recompute directly in recoverRotation for this profile.
    terms: "product", // special-cased below
    productTerms: [
      { args: [0x4944, 0x2c21], sign: -1, div: 2 },
      { args: [0x234e, 0x1acc], sign: -1, div: 12 },
      { args: [0x85e6], sign: +1, div: 5 },
      { args: [0x68c], sign: +1, div: 6 },
      { args: [0x5a31], sign: -1, div: 7 },
      { args: [0x38a4, 0x4ee9], sign: -1, div: 72 },
      { args: [0x5103], sign: +1, div: 10 },
    ],
  },
};

// Active profile (mutable; set by detectProfile / --profile).
let ACTIVE = PROFILES.extension;

function detectProfile(src) {
  // Prefer the profile whose array-variable literal is actually present in the source.
  for (const [name, p] of Object.entries(PROFILES)) {
    if (src.includes(`${p.arrayVar}=[`) || src.includes(`const ${p.arrayVar}=[`)) {
      return p;
    }
  }
  return PROFILES.extension;
}

// ---------------------------------------------------------------------------
// String-aware bracket matching. Walks `src` from `from` tracking whether we are
// inside a single/double-quoted string (and backslash escapes), so `[`/`]`/`{`/`}`
// inside string literals are ignored. Returns the index one past the matching
// close bracket, or -1 if none.
// ---------------------------------------------------------------------------
function findMatchingBracket(src, openIndex) {
  const open = src[openIndex];
  const close = open === "[" ? "]" : open === "{" ? "}" : open;
  let depth = 0;
  let inStr = false;
  let strDelim = null;
  let esc = false;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (!inStr) {
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      } else if (c === "'" || c === '"') {
        inStr = true;
        strDelim = c;
      }
    } else {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === strDelim) {
        inStr = false;
        strDelim = null;
      }
    }
  }
  return -1;
}

// Extract the string array literal (variable name from ACTIVE profile) and return it.
function extractStringArray(src) {
  const { arrayVar, factory } = ACTIVE;
  const factoryIdx = src.indexOf("function " + factory);
  const arrAssign = src.indexOf(arrayVar + "=[", factoryIdx >= 0 ? factoryIdx : 0);
  if (arrAssign < 0) {
    // Fallback: the array may be assigned inside the factory as `const _0x…=[...]`.
    const alt = src.indexOf("const " + arrayVar + "=[");
    if (alt < 0) throw new Error(`Could not locate "${arrayVar}=[" array literal`);
    return evaluateArrayLiteral(src, alt + ("const " + arrayVar + "=").length);
  }
  return evaluateArrayLiteral(src, arrAssign + (arrayVar + "=").length);
}

function evaluateArrayLiteral(src, literalOpenIndex) {
  const end = findMatchingBracket(src, literalOpenIndex);
  if (end < 0) throw new Error("Unterminated string-array literal");
  let code = src.slice(literalOpenIndex, end);

  // Escape every non-ASCII code point as \uXXXX (surrogate-pair safe). Some entries
  // carry raw CJK/BMP+ chars that otherwise break `Function` evaluation.
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const cp = code.codePointAt(i);
    if (cp > 127) {
      if (cp > 0xffff) {
        const hi = 0xd800 + ((cp - 0x10000) >> 10);
        const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
        out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
        i++; // consume the low surrogate
      } else {
        out += "\\u" + cp.toString(16).padStart(4, "0");
      }
    } else {
      out += code[i];
    }
  }

  // eslint-disable-next-line no-new-func
  const arr = Function("return " + out)();
  if (!Array.isArray(arr)) throw new Error("String-array literal did not evaluate to an array");
  return arr;
}

// Recover the left-rotation count C by simulating the self-defending rotate-loop checksum.
// The extension uses a signed sum of `parseInt(array[arg-offset])/div`; aiServerMainV2 uses
// a multiply-nested product. Both are modeled from ACTIVE.terms / ACTIVE.productTerms.
function recoverRotation(arr) {
  const n = arr.length;
  const pi = (s) => parseInt(String(s), 10);

  for (let c = 0; c < n; c++) {
    const r = arr.slice(c).concat(arr.slice(0, c)); // left-rotate by c
    let sum = 0;

    if (ACTIVE.terms === "product") {
      // Multiply-nested: each term is ±(∏ parse/div).
      for (const t of ACTIVE.productTerms) {
        let factor = t.sign;
        for (const a of t.args) factor *= pi(r[a - ACTIVE.offset]);
        sum += factor / t.div;
      }
    } else {
      for (const { arg, sign, div } of ACTIVE.terms) {
        sum += sign * (pi(r[arg - ACTIVE.offset]) / div);
      }
    }

    if (sum === ACTIVE.checksum) return c;
  }
  throw new Error(`Could not recover rotation count (checksum never matched 0x${ACTIVE.checksum.toString(16)})`);
}

// Build the correctly-rotated array and a decoder.
function buildDecoder(src) {
  const raw = extractStringArray(src);
  const c = recoverRotation(raw);
  const rotated = raw.slice(c).concat(raw.slice(0, c));
  const decode = (arg) => rotated[arg - ACTIVE.offset];
  return { rotated, decode, rotationCount: c, size: rotated.length, offset: ACTIVE.offset };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function usage() {
  const name = "decode-trae.js";
  return [
    "Usage:",
    `  node scripts/${name} <bundle.js> strings`,
    `  node scripts/${name} <bundle.js> decode 0xf8d [0x35ef ...]`,
    `  node scripts/${name} <bundle.js> endpoints`,
    `  node scripts/${name} <bundle.js> scan <regex>`,
    `  node scripts/${name} --profile <extension|aiServer> <bundle.js> <cmd>`,
    "",
    "  <bundle.js>   path to an obfuscated bundle (dist/extension.js OR",
    "                resource/aiserver/aiServerMainV2.js). Profile auto-detected.",
  ].join("\n");
}

const ENDPOINT_RE =
  /^(chat|code|api|v[0-9]|ide|auth|token|sso|oauth|passport|user|usage|model|completion|inference|conversation|message|agent|multimodal|cloudide|proxy|service|trae|plugin|personal|settings|retrieval)[a-zA-Z0-9/_.?-]*$|^\//;

function main() {
  const args = process.argv.slice(2);
  let profileOverride = null;
  if (args[0] === "--profile") {
    profileOverride = args[1];
    args.splice(0, 2);
  }
  if (args.length < 2) {
    console.error(usage());
    process.exit(1);
  }
  const [file, command, ...rest] = args;
  if (!fs.existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf8");
  ACTIVE = profileOverride ? PROFILES[profileOverride] || ACTIVE : detectProfile(src);
  const { rotated, decode, rotationCount, size, offset } = buildDecoder(src);

  console.error(`# ${path.basename(file)} — ${size} strings, rotation C=${rotationCount}, offset=0x${offset.toString(16)}\n`);

  switch (command) {
    case "strings": {
      rotated.forEach((s, i) => {
        console.log(`0x${(i + offset).toString(16)}\t${JSON.stringify(s)}`);
      });
      break;
    }
    case "decode": {
      for (const argStr of rest) {
        const arg = Number(argStr); // accepts 0x hex or decimal
        const val = decode(arg);
        console.log(`0x${arg.toString(16)}\t${JSON.stringify(val)}`);
      }
      break;
    }
    case "endpoints": {
      rotated.forEach((s, i) => {
        if (typeof s === "string" && ENDPOINT_RE.test(s)) {
          console.log(`0x${(i + offset).toString(16)}\t${JSON.stringify(s)}`);
        }
      });
      break;
    }
    case "scan": {
      const re = new RegExp(rest[0], "i");
      rotated.forEach((s, i) => {
        if (typeof s === "string" && re.test(s)) {
          console.log(`0x${(i + offset).toString(16)}\t${JSON.stringify(s)}`);
        }
      });
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(usage());
      process.exit(1);
  }
}

main();
