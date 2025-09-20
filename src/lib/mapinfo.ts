import luaparse from 'luaparse';

export type LuaValue =
  | null
  | boolean
  | number
  | string
  | { [k: string]: LuaValue }
  | LuaValue[];

/**
 * Very small evaluator for a subset of Lua used by Spring mapinfo.lua:
 * - Supports either: `return { ... }` or `local mapinfo = { ... }` at top-level
 * - Supports: string/number/boolean literals, nested tables with string keys
 * - Limited support for array-like table values (TableValue): collected as an array under numeric keys or returned as a JS array if the whole table is array-like.
 * - Ignores functions, identifiers, binary/unary expressions, and VFS.Include — caller should pass the resolved mapinfo.lua content.
 */
export function parseMapinfoLua(text: string): any {
  // First pass: try parsing full file
  const sanitized = sanitizeMapinfoText(text);
  try {
    const ast = luaparse.parse(sanitized, {
      luaVersion: '5.1',
      comments: false,
      locations: false,
      ranges: false,
      scope: false,
    });
    const tableNode = findTopLevelMapinfoTable(ast);
    if (tableNode) return evalNode(tableNode);
  } catch {
    // fall through to extraction fallback
  }

  // Fallback: extract the `mapinfo = { ... }` table and parse just that as `return { ... }`
  const extracted = extractMapinfoTableSource(sanitized);
  if (extracted) {
    const ast2 = luaparse.parse(extracted, {
      luaVersion: '5.1',
      comments: false,
      locations: false,
      ranges: false,
      scope: false,
    });
    const ret = (ast2.body || []).find((n: any) => n.type === 'ReturnStatement');
    const arg = ret?.arguments?.[0];
    if (arg) return evalNode(arg);
  }

  throw new Error('mapinfo.lua: could not locate a top-level table. Ensure file defines `local mapinfo = { ... }` or returns a table.');
}

/**
 * Some mapinfo.lua files include decorative separators or BOMs that are not valid Lua.
 * This function normalizes such inputs so luaparse can handle them:
 * - Strips UTF-8 BOM
 * - Converts CRLF/CR to LF
 * - Converts lines consisting only of repeated separators (---- or ====, etc) into comments
 */
export function sanitizeMapinfoText(text: string): string {
  // Remove UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  // Normalize newlines
  text = text.replace(/\r\n?/g, '\n');

  // Replace pure separator lines with Lua comments
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    // Lines that are only runs of '-', '=', or '_' (length >= 4) are not valid Lua
    if (/^[-=_]{4,}$/.test(trimmed)) {
      lines[i] = '-- ' + line;
    }
  }
  return lines.join('\n');
}

function findTopLevelMapinfoTable(ast: any): any {
  // 1) Prefer explicit `return { ... }`
  for (const node of ast.body ?? []) {
    if (node.type === 'ReturnStatement' && node.arguments && node.arguments.length > 0) {
      const arg = node.arguments[0];
      if (arg?.type === 'TableConstructorExpression') return arg;
    }
  }

  // 2) Look for `local mapinfo = { ... }` or `mapinfo = { ... }`
  for (const node of ast.body ?? []) {
    if ((node.type === 'LocalStatement' || node.type === 'AssignmentStatement')
      && Array.isArray(node.variables) && Array.isArray(node.init)) {
      const vars = node.variables;
      const inits = node.init;
      const count = Math.min(vars.length, inits.length);
      for (let i = 0; i < count; i++) {
        const v = vars[i];
        const init = inits[i];
        if (v && v.type === 'Identifier' && v.name === 'mapinfo' && init && init.type === 'TableConstructorExpression') {
          return init;
        }
      }
    }
  }

  // 3) Some mapinfo.lua end with `return mapinfo`.
  //    If we detect that pattern, resolve the earlier `mapinfo = { ... }`
  for (const node of ast.body ?? []) {
    if (node.type === 'ReturnStatement' && node.arguments && node.arguments.length > 0) {
      const arg = node.arguments[0];
      if (arg?.type === 'Identifier' && arg.name === 'mapinfo') {
        // find the last assignment to 'mapinfo' with a table initializer
        for (let j = (ast.body?.length ?? 0) - 1; j >= 0; j--) {
          const st = ast.body[j];
          if ((st.type === 'LocalStatement' || st.type === 'AssignmentStatement')
            && Array.isArray(st.variables) && Array.isArray(st.init)) {
            const vars = st.variables;
            const inits = st.init;
            const count = Math.min(vars.length, inits.length);
            for (let i = 0; i < count; i++) {
              const v = vars[i];
              const init = inits[i];
              if (v && v.type === 'Identifier' && v.name === 'mapinfo' && init && init.type === 'TableConstructorExpression') {
                return init;
              }
            }
          }
        }
      }
    }
  }

  // 4) Fallback: first table on RHS of any local/assignment
  for (const node of ast.body ?? []) {
    if ((node.type === 'LocalStatement' || node.type === 'AssignmentStatement') && Array.isArray(node.init)) {
      for (const init of node.init) {
        if (init && init.type === 'TableConstructorExpression') {
          return init;
        }
      }
    }
  }

  return null;
}

/**
 * Try to extract the `mapinfo = { ... }` table literal from a larger file and
 * return a standalone Lua chunk: `return { ... }` so luaparse can handle it.
 * This ignores code outside the table (e.g. helper functions, VFS includes).
 */
export function extractMapinfoTableSource(src: string): string | null {
  const re = /(local\s+)?mapinfo\s*=\s*\{/i;
  const m = re.exec(src);
  if (!m) return null;

  // Start at the first { after the match
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;

  // Scan forward to find the matching closing brace, naive balance with basic string handling
  let i = start;
  let depth = 0;
  let inStr = false;
  let strQuote: string | null = null;
  while (i < src.length) {
    const ch = src[i];

    if (inStr) {
      if (ch === '\\') { // skip escape
        i += 2;
        continue;
      }
      if (ch === strQuote) {
        inStr = false;
        strQuote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      strQuote = ch;
      i++;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const tableText = src.slice(start, i + 1);
        return `return ${tableText}`;
      }
    }
    i++;
  }

  return null;
}

function evalNode(node: any): LuaValue {
  if (!node) return null;

  switch (node.type) {
    case 'NilLiteral':
      return null;
    case 'BooleanLiteral':
      return !!node.value;
    case 'NumericLiteral': {
      const v: any = (node as any).value;
      if (typeof v === 'number') return v;
      const raw = (node as any).raw;
      const n = Number(raw ?? v ?? 0);
      return Number.isFinite(n) ? n : 0;
    }
    case 'StringLiteral': {
      // luaparse should populate `value`, but be robust and fall back to stripping quotes from `raw`
      const v = (node as any).value;
      if (typeof v === 'string') return v;
      const raw = String((node as any).raw ?? '');
      // Strip single or double quotes if present
      const m = raw.match(/^(['"])([\s\S]*)\1$/);
      return m ? (m[2] ?? '') : raw;
    }
    case 'TableConstructorExpression':
      return evalTable(node);
    // Graceful fallback: if someone writes `return ( { ... } )`
    case 'ParenExpression':
      return evalNode(node.expression);
    case 'UnaryExpression': {
      // Handle numeric negation, e.g. -0.8
      const op = (node as any).operator;
      const arg = evalNode((node as any).argument);
      if (op === '-' && typeof arg === 'number') return -arg;
      if (op === '+' && typeof arg === 'number') return +arg;
      // Logical not or bitwise not not required for mapinfo, default to null
      return null;
    }
    default:
      // Unsupported expression (Identifier, CallExpression, Function, etc.)
      // Return null to avoid crashing; caller can inspect missing fields.
      return null;
  }
}

function evalTable(node: any): LuaValue {
  const obj: Record<string, LuaValue> = {};
  const arr: LuaValue[] = [];
  let hasArrayValues = false;
  let hasObjectKeys = false;

  for (const field of node.fields ?? []) {
    switch (field.type) {
      // { key = value }
      case 'TableKeyString': {
        hasObjectKeys = true;
        obj[field.key.name] = evalNode(field.value);
        break;
      }
      // { [expr] = value } — treat numeric string/number keys as string keys
      case 'TableKey': {
        hasObjectKeys = true;
        const k = evalNode(field.key);
        const keyStr = String(k);
        obj[keyStr] = evalNode(field.value);
        break;
      }
      // { value } — array-like positional elements
      case 'TableValue': {
        hasArrayValues = true;
        arr.push(evalNode(field.value));
        break;
      }
      default:
        break;
    }
  }

  if (hasArrayValues && !hasObjectKeys) {
    return arr;
  }

  if (hasArrayValues) {
    // Also expose array values under a conventional key for mixed tables
    obj._array = arr;
  }

  return obj;
}
