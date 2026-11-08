#!/usr/bin/env node
/**
 * Lints the Maestro workspace without Maestro: every `.maestro/*.yaml` must parse, have the
 * `appId` header + a command list, use only known command names, reference `${VARS}` that are
 * declared (header `env:` or a `# params:` line), and point `runFlow: file:` at files that exist.
 * Also parses `app/.eas/workflows/*.yml` (jobs, `needs` targets) and checks `app/eas.json` has the
 * `demo-simulator` profile the EAS workflow builds. Exit 1 on the first problem list.
 *
 *   node .maestro/lint.mjs            # js-yaml from app/node_modules or NODE_PATH
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

function loadYamlLib() {
  for (const candidate of [join(root, 'app', 'node_modules', 'js-yaml'), 'js-yaml']) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error('js-yaml not found: run `npm ci` in app/ or set NODE_PATH to a folder with js-yaml@4');
}
const yaml = loadYamlLib();

const COMMANDS = new Set([
  'addMedia', 'assertNotVisible', 'assertTrue', 'assertVisible', 'assertWithAI', 'assertNoDefectsWithAI', 'back',
  'clearKeychain', 'clearState', 'copyTextFrom', 'doubleTapOn', 'eraseText', 'evalScript', 'extendedWaitUntil',
  'extractTextWithAI', 'hideKeyboard', 'inputRandomEmail', 'inputRandomNumber', 'inputRandomPersonName',
  'inputRandomText', 'inputText', 'killApp', 'launchApp', 'longPressOn', 'openBrowser', 'openLink', 'pasteText',
  'pressKey', 'repeat', 'retry', 'runFlow', 'runScript', 'scroll', 'scrollUntilVisible', 'setAirplaneMode',
  'setLocation', 'startRecording', 'stopApp', 'stopRecording', 'swipe', 'takeScreenshot', 'tapOn',
  'toggleAirplaneMode', 'travel', 'waitForAnimationToEnd',
]);

const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

function walkStrings(node, visit) {
  if (typeof node === 'string') visit(node);
  else if (Array.isArray(node)) node.forEach((n) => walkStrings(n, visit));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => walkStrings(n, visit));
}

function lintCommands(file, commands, dir) {
  const walk = (list, path) => {
    if (!Array.isArray(list)) return fail(file, `${path} must be a list of commands`);
    list.forEach((cmd, i) => {
      const at = `${path}[${i}]`;
      if (typeof cmd === 'string') {
        if (!COMMANDS.has(cmd)) fail(file, `${at}: unknown command "${cmd}"`);
        return;
      }
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return fail(file, `${at}: not a command`);
      const keys = Object.keys(cmd);
      if (keys.length !== 1) return fail(file, `${at}: a command is one key, got ${keys.join(', ')} (indentation?)`);
      const [name] = keys;
      if (!COMMANDS.has(name)) fail(file, `${at}: unknown command "${name}"`);
      const arg = cmd[name];
      if (name === 'runFlow' && arg && typeof arg === 'object') {
        if (arg.file) {
          const target = join(dir, String(arg.file));
          if (!existsSync(target)) fail(file, `${at}: runFlow file not found: ${arg.file}`);
        } else if (!Array.isArray(arg.commands)) {
          fail(file, `${at}: runFlow needs file: or commands:`);
        }
        if (Array.isArray(arg.commands)) walk(arg.commands, `${at}.commands`);
      }
      if (name === 'runFlow' && typeof arg === 'string' && !existsSync(join(dir, arg))) {
        fail(file, `${at}: runFlow file not found: ${arg}`);
      }
      if ((name === 'repeat' || name === 'retry') && arg && Array.isArray(arg.commands)) walk(arg.commands, `${at}.commands`);
    });
  };
  walk(commands, 'commands');
}

function lintFlow(file) {
  const text = readFileSync(file, 'utf8');
  let docs;
  try {
    docs = yaml.loadAll(text);
  } catch (e) {
    return fail(file, `YAML syntax: ${e.message.split('\n')[0]}`);
  }
  if (docs.length < 1 || docs.length > 2) return fail(file, `expected header + commands (2 documents), got ${docs.length}`);
  const [header, commands] = docs.length === 2 ? docs : [{}, docs[0]];
  if (!header || typeof header !== 'object' || typeof header.appId !== 'string') fail(file, 'header needs appId');
  if (!Array.isArray(commands)) return fail(file, 'the second document must be the command list');
  lintCommands(file, commands, dirname(file));

  // ${VAR} references must be declared: header env, or a "# params: A B" comment for helpers.
  const declared = new Set(Object.keys((header && header.env) || {}));
  const params = /^#\s*params:\s*(.+)$/m.exec(text);
  if (params) params[1].split(/[\s,]+/).filter(Boolean).forEach((p) => declared.add(p));
  const used = new Set();
  walkStrings(docs, (s) => {
    for (const m of s.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\|\||\})/g)) used.add(m[1]);
  });
  // a header default like `X: ${X || "..."}` references itself: that is the declaration, not a use
  for (const v of used) if (!declared.has(v)) fail(file, `\${${v}} is not declared in env: (or a "# params:" line)`);
}

function lintWorkspaceConfig(file) {
  let cfg;
  try {
    cfg = yaml.load(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(file, `YAML syntax: ${e.message.split('\n')[0]}`);
  }
  if (!cfg || !Array.isArray(cfg.flows) || !cfg.flows.some((f) => !String(f).startsWith('!'))) {
    fail(file, 'flows: needs at least one positive pattern');
  }
}

function lintEasWorkflow(file, easJson) {
  let wf;
  try {
    wf = yaml.load(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(file, `YAML syntax: ${e.message.split('\n')[0]}`);
  }
  if (!wf || typeof wf !== 'object') return fail(file, 'empty workflow');
  if (!wf.on) fail(file, 'missing on:');
  if (!wf.jobs || typeof wf.jobs !== 'object') return fail(file, 'missing jobs:');
  const ids = new Set(Object.keys(wf.jobs));
  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const dep of [].concat(job.needs ?? [], job.after ?? [])) {
      if (!ids.has(dep)) fail(file, `job ${id} needs unknown job ${dep}`);
    }
    if (job.type === 'build' && easJson) {
      const profile = job.params?.profile ?? 'production';
      if (!easJson.build?.[profile]) fail(file, `job ${id} builds profile "${profile}" missing from app/eas.json`);
    }
    if (job.type === 'maestro') {
      if (!job.params?.build_id) fail(file, `job ${id}: params.build_id is required`);
      const flows = [].concat(job.params?.flow_path ?? []);
      if (flows.length === 0) fail(file, `job ${id}: params.flow_path is required`);
      for (const f of flows) {
        // flow_path is relative to the Expo project root (app/), where this workflow file lives
        const target = resolve(root, 'app', String(f));
        if (!existsSync(target)) fail(file, `job ${id}: flow_path not found from app/: ${f}`);
      }
    }
  }
  if (statSync(file).size > 16 * 1024) fail(file, 'EAS workflow files must be 16 KiB or smaller');
}

// ---- run ----
const flowDir = here;
for (const name of readdirSync(flowDir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
  const file = join(flowDir, name);
  if (name === 'config.yaml') lintWorkspaceConfig(file);
  else lintFlow(file);
}

let easJson = null;
const easPath = join(root, 'app', 'eas.json');
if (existsSync(easPath)) {
  try {
    easJson = JSON.parse(readFileSync(easPath, 'utf8'));
    const demo = easJson.build?.['demo-simulator'];
    if (!demo) fail(easPath, 'build.demo-simulator profile is missing');
    else {
      if (demo.ios?.simulator !== true) fail(easPath, 'demo-simulator must set ios.simulator: true');
      if (demo.env?.EXPO_PUBLIC_DEMO !== '1') fail(easPath, 'demo-simulator must set env.EXPO_PUBLIC_DEMO: "1"');
    }
  } catch (e) {
    fail(easPath, `JSON: ${e.message}`);
  }
}

const wfDir = join(root, 'app', '.eas', 'workflows');
if (existsSync(wfDir)) {
  for (const name of readdirSync(wfDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml')).sort()) {
    lintEasWorkflow(join(wfDir, name), easJson);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('maestro lint: ok');
