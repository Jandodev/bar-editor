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
 * - Expects: return { ... } at top-level
 * - Supports: string/number/boolean literals, nested tables with string keys
 * - Limited support for array-like table values (TableValue): collected as an array under numeric keys or returned as a JS array if the whole table is array-like.
 * - Ignores functions, identifiers, binary/unary expressions, and VFS.Include — caller should pass the resolved mapinfo.lua content.
 */
export function parseMapinfoLua(text: string): any {
  const ast = luaparse.parse(text, {
    luaVersion: '5.1',
    comments: false,
    locations: false,
    ranges: false,
    scope: false,
  });

  // Find first return statement
  const ret = ast.body.find((n: any) => n.type === 'ReturnStatement') as any;
  if (!ret || !ret.arguments || ret.arguments.length === 0) {
    throw new Error('mapinfo.lua: expected "return { ... }"');
  }
  const arg = ret.arguments[0];

  const value = evalNode(arg);
  return value;
}

function evalNode(node: any): LuaValue {
  if (!node) return null;

  switch (node.type) {
    case 'NilLiteral':
      return null;
    case 'BooleanLiteral':
      return !!node.value;
    case 'NumericLiteral':
      return typeof node.value === 'number' ? node.value : Number(node.raw);
    case 'StringLiteral':
      return String(node.value);
    case 'TableConstructorExpression':
      return evalTable(node);
    // Graceful fallback: if someone writes `return ( { ... } )`
    case 'ParenExpression':
      return evalNode(node.expression);
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
