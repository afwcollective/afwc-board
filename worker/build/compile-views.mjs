/**
 * Precompile every EJS template in views/ into a plain JavaScript module the
 * Worker can bundle.
 *
 * WHY: Workers forbid eval / new Function, so EJS cannot compile a template at
 * runtime. `ejs.compile(source, { client: true })` hands back a *function* whose
 * source we can serialise at build time and ship as ordinary code.
 *
 * THE `with` PROBLEM (the reason this file is longer than three lines):
 * EJS's default compilation wraps the template body in `with (locals || {}) {}`
 * so `<%= title %>` resolves against the locals object. ES modules are always
 * strict mode, and `with` is a SyntaxError in strict mode — so the moment the
 * generated code is bundled into an ESM Worker it fails to parse. There is no
 * way around it by configuration alone.
 *
 * The fix EJS offers is `_with: false` plus `destructuredLocals: [...]`, which
 * emits `var __locals = (locals || {}), title = __locals.title, …` instead. That
 * requires knowing, per template, exactly which free identifiers the template
 * body reads. So this script:
 *
 *   1. compiles once with `_with: false` and no destructuring,
 *   2. parses the resulting function with acorn and walks its scopes to find
 *      every identifier that is referenced but never bound (params, var/let/
 *      const/function/class/catch declarations all count as bound),
 *   3. subtracts the real JavaScript/Workers globals,
 *   4. recompiles with what is left as `destructuredLocals`.
 *
 * The result is behaviourally identical to the `with` form for every template
 * in this app: a name that is missing from the locals object destructures to
 * `undefined`, which is exactly what `with` produced, and which is what the
 * `typeof pageCss !== 'undefined'` guards in views/partials/head.ejs rely on.
 *
 * INCLUDES resolve at RUNTIME, not build time, through the shim in
 * worker/src/views/render.js — but only ever against this build's registry, so
 * nothing is looked up on a filesystem. Include paths are resolved relative to
 * the including template exactly the way ejs's own getIncludePath does, which is
 * why `include('partials/head')` from layout.ejs and `include('../partials/
 * form-errors')` from auth/login.ejs both land in the same place they do under
 * Express.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import * as acorn from 'acorn';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VIEWS_DIR = path.join(ROOT, 'views');
const OUT_FILE = path.join(ROOT, 'worker', '.generated', 'views.js');

/**
 * Identifiers that are genuinely global in workerd and must NOT be turned into
 * locals — `Math.max(...)` in views/home.ejs is the one that bites first.
 * Anything not on this list and not declared in the template becomes a local,
 * which is the safe direction to be wrong in: undefined rather than a
 * ReferenceError at render time.
 */
const GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments', 'this',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Function', 'Proxy', 'Reflect',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Intl',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError', 'URIError',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'console', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'Uint8Array', 'ArrayBuffer', 'atob', 'btoa', 'crypto', 'structuredClone',
]);

/* ------------------------------------------------------------ scope walker --
 * A small, complete-enough scope analyser. It is deliberately conservative: it
 * hoists `var`/function declarations to the enclosing function scope and keeps
 * let/const/class in their block, so a name is reported free only when nothing
 * in any enclosing scope binds it.
 */

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
]);

/** Every name a binding pattern introduces (identifier, destructuring, rest…). */
function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p : p.value, out);
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    default:
      break;
  }
  return out;
}

/** Child nodes of `node`, in no particular order. */
function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v.type === 'string') out.push(v);
    } else if (value && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out;
}

/**
 * var + function declarations reachable from `node` without crossing into a
 * nested function — i.e. the names that hoist to this function's scope.
 */
function hoistedVars(node, out = []) {
  for (const child of children(node)) {
    if (FUNCTION_TYPES.has(child.type)) {
      if (child.type === 'FunctionDeclaration' && child.id) out.push(child.id.name);
      continue; // do not descend into another function's body
    }
    if (child.type === 'VariableDeclaration' && child.kind === 'var') {
      for (const d of child.declarations) patternNames(d.id, out);
    }
    if (child.type === 'ClassDeclaration' || child.type === 'ClassExpression') continue;
    hoistedVars(child, out);
  }
  return out;
}

/** let/const/class/function declarations directly inside one block. */
function blockScopedNames(statements, out = []) {
  for (const st of statements || []) {
    if (st.type === 'VariableDeclaration' && st.kind !== 'var') {
      for (const d of st.declarations) patternNames(d.id, out);
    } else if (st.type === 'ClassDeclaration' && st.id) {
      out.push(st.id.name);
    } else if (st.type === 'FunctionDeclaration' && st.id) {
      out.push(st.id.name);
    }
  }
  return out;
}

/** Every identifier referenced but never bound, anywhere under `root`. */
function freeIdentifiers(root) {
  const free = new Set();
  const stack = [];
  const bound = (name) => stack.some((s) => s.has(name));

  function enterFunction(node, visitBody) {
    const scope = new Set();
    if (node.id && node.type === 'FunctionExpression') scope.add(node.id.name);
    for (const p of node.params || []) for (const n of patternNames(p)) scope.add(n);
    scope.add('arguments');
    for (const n of hoistedVars(node.body || node)) scope.add(n);
    stack.push(scope);
    visitBody();
    stack.pop();
  }

  function visit(node, parent) {
    if (!node) return;

    switch (node.type) {
      case 'Identifier': {
        // Skip positions where an identifier is a name, not a reference.
        if (parent) {
          if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
          if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
          if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
              && parent.key === node && !parent.computed) return;
          if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement'
              || parent.type === 'ContinueStatement') return;
        }
        if (!bound(node.name) && !GLOBALS.has(node.name)) free.add(node.name);
        return;
      }

      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        enterFunction(node, () => {
          for (const p of node.params || []) visitDefaults(p);
          visit(node.body, node);
        });
        return;

      case 'BlockStatement': {
        const scope = new Set(blockScopedNames(node.body));
        stack.push(scope);
        for (const st of node.body) visit(st, node);
        stack.pop();
        return;
      }

      case 'CatchClause': {
        const scope = new Set(node.param ? patternNames(node.param) : []);
        stack.push(scope);
        visit(node.body, node);
        stack.pop();
        return;
      }

      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const scope = new Set();
        const decl = node.init && node.init.type === 'VariableDeclaration' ? node.init
          : (node.left && node.left.type === 'VariableDeclaration' ? node.left : null);
        if (decl) for (const d of decl.declarations) for (const n of patternNames(d.id)) scope.add(n);
        stack.push(scope);
        for (const child of children(node)) visit(child, node);
        stack.pop();
        return;
      }

      case 'VariableDeclarator':
        // The declared name is a binding, not a reference; only the init reads.
        for (const n of patternNames(node.id)) {
          if (!bound(n)) stack[stack.length - 1].add(n);
        }
        visitDefaults(node.id);
        visit(node.init, node);
        return;

      case 'MemberExpression':
        visit(node.object, node);
        if (node.computed) visit(node.property, node);
        return;

      case 'Property':
        if (node.computed) visit(node.key, node);
        visit(node.value, node);
        return;

      default:
        for (const child of children(node)) visit(child, node);
    }
  }

  /** Default values inside a binding pattern are real expressions. */
  function visitDefaults(pattern) {
    if (!pattern) return;
    if (pattern.type === 'AssignmentPattern') {
      visit(pattern.right, pattern);
      visitDefaults(pattern.left);
    } else if (pattern.type === 'ObjectPattern') {
      for (const p of pattern.properties) {
        if (p.type === 'Property' && p.computed) visit(p.key, p);
        visitDefaults(p.type === 'RestElement' ? p.argument : p.value);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) visitDefaults(el);
    } else if (pattern.type === 'RestElement') {
      visitDefaults(pattern.argument);
    }
  }

  stack.push(new Set()); // program scope
  visit(root, null);
  stack.pop();
  return free;
}

/* ------------------------------------------------------------- compilation -- */

function walkViews(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkViews(full, prefix ? `${prefix}/${entry.name}` : entry.name));
    } else if (entry.name.endsWith('.ejs')) {
      const base = entry.name.slice(0, -4);
      out.push({ name: prefix ? `${prefix}/${base}` : base, file: full });
    }
  }
  return out;
}

/**
 * EJS options shared by both compilation passes. compileDebug is off: it would
 * embed a copy of every template's source text in the bundle and wire up a
 * `rethrow` helper, which buys line numbers we cannot see in production anyway.
 */
const BASE_OPTS = {
  client: true,
  _with: false,
  localsName: 'locals',
  compileDebug: false,
  rmWhitespace: false, // byte-for-byte whitespace parity with the Express render
};

function compileOne({ name, file }) {
  const source = fs.readFileSync(file, 'utf8');

  // Pass 1 — find the template's free identifiers.
  const probe = ejs.compile(source, { ...BASE_OPTS, filename: file });
  const ast = acorn.parseExpressionAt(`(${probe.toString()})`, 0, {
    ecmaVersion: 2022,
    allowReturnOutsideFunction: true,
  });
  const free = [...freeIdentifiers(ast)].sort();

  // Pass 2 — recompile with those names destructured off `locals`.
  const fn = free.length
    ? ejs.compile(source, { ...BASE_OPTS, filename: file, destructuredLocals: free })
    : ejs.compile(source, { ...BASE_OPTS, filename: file });

  return { name, free, code: fn.toString() };
}

export function compileViews({ quiet = false } = {}) {
  const views = walkViews(VIEWS_DIR);
  const compiled = views.map(compileOne);

  const parts = [
    '// AUTO-GENERATED by worker/build/compile-views.mjs — do not edit.',
    `// Source: views/ (${compiled.length} templates), compiled with ejs client mode.`,
    '',
    'const views = Object.create(null);',
    '',
  ];
  for (const { name, free, code } of compiled) {
    parts.push(`/* views/${name}.ejs — locals: ${free.length ? free.join(', ') : '(none)'} */`);
    parts.push(`views[${JSON.stringify(name)}] = ${code};`);
    parts.push('');
  }
  parts.push('export default views;');

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, parts.join('\n'), 'utf8');

  if (!quiet) {
    for (const { name, free } of compiled) {
      console.log(`  views/${name}.ejs  ←  ${free.length ? free.join(' ') : '(no locals)'}`);
    }
    const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
    console.log(`[views] ${compiled.length} templates → worker/.generated/views.js (${kb} KB)`);
  }
  return { count: compiled.length, out: OUT_FILE };
}

if (import.meta.url === `file://${process.argv[1]}`) compileViews();
