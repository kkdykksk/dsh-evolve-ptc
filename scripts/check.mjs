#!/usr/bin/env node
/**
 * 自检脚本：不启动 DSH，直接验证「清单契约 + 预设派生 + 状态层 + 客户端外形」。
 *
 * 用法：`node scripts/check.mjs [--verbose]`
 *   派生会优先读宿主文档（asar / baseUrl）；在 Electron 之外读不到 asar 时，自动退回
 *   `test/fixtures/*.patch.yml` 里的官方文档副本（副本会过期，所以结果里会注明来源）。
 * 退出码 0 = 通过；1 = 有失败项（每项都带修法）。
 *
 * 创造模式每造一个插件都会跑同源的检查（见 lib/creation.mjs 的 validateBundle）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { DEFAULTS, normalizeConfig, overrideFile } from '../lib/config.mjs';
import { createResolver } from '../lib/resolve.mjs';
import { derivePreset, PRESET_ID, PRESET_ORDER, RUNTIME_ROW_ID } from '../lib/derive.mjs';
import { detect, rankRules, recordLesson, scopeForCwd } from '../lib/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const verbose = process.argv.includes('--verbose');
// 自检不能污染真实状态目录：规则/账本/快照全部落到临时 EVOLVE_ROOT。
const checkStateRoot = join(tmpdir(), `evolve-check-state-${process.pid.toString(36)}`);
process.env.EVOLVE_ROOT = checkStateRoot;
const failures = [];
const notices = [];
const fail = (message, fix) => failures.push({ message, fix });
const note = message => {
  notices.push(message);
  if (verbose) console.log(`  · ${message}`);
};
const pass = message => {
  if (verbose) console.log(`  ✔ ${message}`);
};
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const profileDir = process.env.DSH_PROFILE_DIR ?? process.env.DSH_PROFILE ?? 'C:\\dsh-home\\profiles\\desktop';
const resolver = createResolver({ baseUrl: profileDir });
const yaml = await resolver.loadYaml();
if (!yaml) {
  console.error('❌ 找不到 js-yaml：先确认 profile 的 node_modules 里有 js-yaml（DSH 自带）');
  process.exit(1);
}

/** 上游文档：宿主优先 → 环境变量 → 包内 fixture。返回 {text, source}。 */
async function upstream(kind, specifier, fixture) {
  const envKey = kind === 'ptc' ? 'EVOLVE_PTC_UPSTREAM' : 'EVOLVE_PTC_CORDIS';
  if (process.env[envKey]) {
    const text = resolver.readPath(process.env[envKey]);
    if (text) return { text, source: envKey };
  }
  const fromHost = resolver.readText(specifier);
  if (fromHost) return { text: fromHost, source: specifier };
  const fixtureFile = join(root, 'test', 'fixtures', fixture);
  if (existsSync(fixtureFile)) {
    // 让 derivePreset 走同一条上游路径（它只认环境变量与宿主解析）。
    process.env[envKey] = fixtureFile;
    return { text: readFileSync(fixtureFile, 'utf8'), source: `test/fixtures/${fixture}` };
  }
  return { text: null, source: 'missing' };
}

// ── 1. package.json 契约 ──────────────────────────────────────────────────
console.log('[1/7] package.json 清单');
const manifest = readJson(join(root, 'package.json'));
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  if (typeof value !== 'string') continue;
  if (value.includes('*')) {
    pass(`exports["${key}"] 是通配（跳过文件存在性检查）`);
    continue;
  }
  if (!existsSync(resolve(root, value))) fail(`exports["${key}"] 指向不存在的文件 ${value}`, '补上文件或删掉这条导出');
  else pass(`exports["${key}"] → ${value}`);
}
for (const required of ['.', './runtime', './client']) {
  if (!manifest.exports?.[required]) fail(`缺少 exports["${required}"]`, `补上 "${required}"`);
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 必须指向 ./cordis.patch.yml', '参照 deep-ptc');
if (!manifest.dsh?.client?.platform) fail('dsh.client.platform 缺失', '写 "web"');
if (!manifest.engines?.node || !manifest.engines?.dsh) note(`engines 建议同时声明 node 与 dsh（当前 ${JSON.stringify(manifest.engines ?? {})}）`);

// ── 2. cordis.patch.yml ──────────────────────────────────────────────────
console.log('[2/7] cordis.patch.yml');
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
let settingsRow = null;
try {
  const document = yaml.load(patchText);
  const rows = (Array.isArray(document) ? document : []).flatMap(layer => (Array.isArray(layer?.insert) ? layer.insert : []));
  settingsRow = rows.find(row => row?.id === 'evolve-ptc-settings') ?? null;
} catch (error) {
  fail(`cordis.patch.yml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`, '修 YAML');
}
if (!settingsRow) fail('patch 里没有 id=evolve-ptc-settings 的行', '参照现有内容补上');
else {
  if (settingsRow.name !== 'dsh-evolve-ptc') fail(`插件入口行 name 应为 dsh-evolve-ptc（实际 ${settingsRow.name}）`, '改成包名');
  const known = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(settingsRow.config ?? {})) {
    if (!known.has(key)) fail(`配置键 ${key} 不在 DEFAULTS 里（会被 normalizeConfig 丢弃）`, '在 lib/config.mjs 的 DEFAULTS 里加，或从 patch 删掉');
    else pass(`配置键 ${key}`);
  }
}

// ── 2b. 入口契约（import 真模块，防止「文件存在但导出损坏」的假阳性） ────
try {
  const entry = await import('../lib/index.mjs');
  if (typeof entry.apply !== 'function') fail('lib/index.mjs 没有导出 apply()', '检查入口模块');
  if (entry.name !== 'evolve-ptc-settings') fail(`入口导出 name 应为 evolve-ptc-settings（实际 ${entry.name}）`, '检查 lib/index.mjs');
  if (!Array.isArray(entry.inject) || !entry.inject.includes('agentPresets')) fail('入口 inject 缺 agentPresets', '检查 lib/index.mjs 的 inject');
  if (typeof entry.status !== 'function') fail('入口缺 status() 诊断导出', '检查 lib/index.mjs');
  else {
    const status = entry.status();
    if (!status || status.presetId !== 'evolve-ptc') fail('status() 未按约定返回 presetId=evolve-ptc', '检查 lib/index.mjs 的 status()');
  }
  if (entry.Config === undefined) note('Config 未导出（宿主 schemastery 不可用时的合法降级）');
  else pass('入口契约 ok（apply/name/inject/status/Config）');
} catch (error) {
  fail(`import lib/index.mjs 失败：${error instanceof Error ? error.message : String(error)}`, '入口模块坏了，自检不能只靠 existsSync');
}

// ── 3. 预设派生 ──────────────────────────────────────────────────────────
console.log('[3/7] 预设派生');
const ptcUpstream = await upstream('ptc', '@deepseek-ai/dsh-web-app/presets/ptc.patch.yml', 'ptc.patch.yml');
const cordisUpstream = await upstream('cordis', '@deepseek-ai/dsh-web-app/presets/cordis.patch.yml', 'cordis.patch.yml');
note(`官方 PTC 文档来源：${ptcUpstream.source}`);
note(`创造模式文档来源：${cordisUpstream.source}`);
if (!ptcUpstream.text) fail('读不到官方 PTC 预设文档', '设置 EVOLVE_PTC_UPSTREAM，或放一份 test/fixtures/ptc.patch.yml');
for (const [kind, value] of [['ptc', ptcUpstream], ['cordis', cordisUpstream]]) {
  if (value.text) mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
  void kind;
}
if (ptcUpstream.text) {
  const config = normalizeConfig({});
  let derived = null;
  try {
    derived = await derivePreset({ baseUrl: profileDir, get: () => undefined }, config, { info: () => {}, warn: () => {}, error: () => {} });
  } catch (error) {
    fail(`派生失败：${error instanceof Error ? error.message : String(error)}`, '看上面的派生来源提示');
  }
  if (derived) {
    const definition = derived.definition;
    for (const warning of derived.warnings) note(`派生警告：${warning}`);
    if (definition.id !== PRESET_ID) fail(`预设 id 应为 ${PRESET_ID}`, '检查 derive.mjs');
    if (definition.order !== PRESET_ORDER) fail(`预设 order 应为 ${PRESET_ORDER}`, '检查 derive.mjs');
    if (!definition.name || !definition.description) fail('预设缺 name/description', '花名册会显示不出来');
    const seen = new Set();
    for (const row of definition.plugins) {
      if (!row || typeof row !== 'object') {
        fail('预设里出现非对象行', '检查派生逻辑');
        continue;
      }
      if (!row.id) fail('预设行缺 id', '检查派生逻辑');
      else if (seen.has(row.id)) fail(`预设行 id 重复：${row.id}`, '派生时去重');
      else seen.add(row.id);
      if (!row.name && row.group !== true) fail(`预设行 ${row.id} 缺 name 且不是 group`, '检查派生逻辑');
    }
    const prefix = definition.plugins.find(row => row.id === 'persona')?.config?.prefix ?? '';
    if (!prefix.includes('观察 → 动作 → 验证')) fail('persona 前缀没有行为契约', '检查 composePersonaPrefix');
    if (!prefix.includes('创造模式')) fail('创造模式开启时 persona 应追加创造模式说明', '检查 CREATIVE_LINE');
    const runtimeRow = definition.plugins.find(row => row.id === RUNTIME_ROW_ID);
    if (!runtimeRow) fail(`预设里没有运行时行 ${RUNTIME_ROW_ID}`, '检查 composeDefinition');
    else if (runtimeRow.name !== 'dsh-evolve-ptc/runtime') fail('运行时行 name 应为 dsh-evolve-ptc/runtime', '检查 composeDefinition');
    if (config.creationMode) {
      const manager = definition.plugins.find(row => row.id === 'tool-plugin-manager');
      if (!manager) fail('创造模式缺少 tool-plugin-manager 行（无法安装插件）', '检查 applyCreationAdditions');
      else if (manager.disabled === true) note('tool-plugin-manager 被禁用（当前环境没有 profileContext）');
      if (!definition.plugins.some(row => String(row.name ?? '').includes('dsh-tool-cordis'))) {
        note('没有 tool-cordis 行（宿主未安装或 asar 不可解析时属正常降级，创造模式仍可用文件+命令）');
      }
    }
    const operations = definition.plugins.filter(row => ['tool-bash', 'tool-pwsh'].includes(row.id));
    if (operations.length === 0) fail('派生结果里一条 shell 行都没有', '官方文档形状变了？检查 parsePatchDocument');
  }
}

// ── 4. 状态层与检测器 ────────────────────────────────────────────────────
console.log('[4/7] 状态层与检测器');
const scope = scopeForCwd(join(root, 'test-scope'));
try {
  const lesson = `自检 ${new Date().toISOString()}：当 checkout 与安装目录不一致时，用 baseUrl 作为解析根，因为 link 安装看不到 profile 的 node_modules`;
  const recorded = recordLesson(scope, lesson, { evidence: 'scripts/check.mjs' });
  if (!recorded.rule?.text) fail('recordLesson 没返回规则', '检查 state.mjs');
  else {
    const ranked = rankRules([recorded.rule], 3);
    if (ranked.length !== 1) fail('rankRules 丢掉唯一一条规则', '检查排序权重');
    else pass('规则写入 + 排序 ok');
  }
  const repeated = detect({
    activity: [
      { name: 'computer_click', ok: false, error: 'timeout' },
      { name: 'computer_click', ok: false, error: 'timeout' },
      { name: 'computer_click', ok: false, error: 'timeout' },
    ],
    config: { hardBlockAfter: 3 },
  });
  if (!repeated.some(hit => hit.code === 'repeatFailure')) fail('repeatFailure 检测器没触发', '检查 detect()');
  else pass('repeatFailure ok');
  const unverified = detect({
    activity: [
      { name: 'computer_click', ok: true },
      { name: 'computer_type', ok: true },
    ],
    config: { hardBlockAfter: 3 },
  });
  if (!unverified.some(hit => hit.code === 'unverifiedWrite')) fail('unverifiedWrite 检测器没触发', '检查 detect()');
  else pass('unverifiedWrite ok');
  const spin = detect({
    activity: Array.from({ length: 4 }, () => ({ name: 'computer_click', ok: true })),
    config: { hardBlockAfter: 3 },
  });
  if (!spin.some(hit => hit.code === 'spin')) fail('spin 检测器没触发', '检查 detect()');
  else pass('spin ok');
  const clean = detect({
    activity: [
      { name: 'computer_click', ok: true },
      { name: 'computer_screenshot', ok: true },
      { name: 'computer_click', ok: true },
    ],
    config: {},
  });
  if (clean.length > 0) fail(`干净序列被误报：${JSON.stringify(clean)}`, '检查 observe/write 工具集');
  else pass('无误报');
  // 本地覆盖文件（$DSH_HOME/evolve/config.json）必须压过显式传入的配置值。
  const overridePath = overrideFile();
  try {
    writeFileSync(overridePath, JSON.stringify({ correctiveBlocks: false, maxRules: 3 }));
    const merged = normalizeConfig({ correctiveBlocks: true, maxRules: 8 });
    if (merged.correctiveBlocks !== false || merged.maxRules !== 3) {
      fail('本地覆盖 config.json 没有生效', '检查 config.mjs 的 normalizeConfig/readOverrides');
    } else pass('覆盖文件 ok');
  } finally {
    try { rmSync(overridePath, { force: true }); } catch { /* 清理失败不影响结论 */ }
  }
} catch (error) {
  fail(`状态层抛异常：${error instanceof Error ? error.message : String(error)}`, '检查 state.mjs');
}

// ── 5. 客户端外形 ────────────────────────────────────────────────────────
console.log('[5/7] 客户端');
const clientFile = join(root, 'lib', 'client.js');
if (!existsSync(clientFile)) fail('lib/client.js 缺失', '设置卡片与面板注册都靠它');
else {
  const client = readFileSync(clientFile, 'utf8');
  if (!client.includes('__ModuleLoader__')) fail('client.js 不是 DSH 客户端模块外形', '按 deep-ptc/lib/client.js 的 load({id, factory}) 形状写');
  if (!client.includes('settings.section')) note('client.js 没有注册 settings.section（设置卡片）');
  if (/require\(['"]@deepseek-ai\//.test(client)) note('client.js 里出现 require("@deepseek-ai/…")：宿主不保证客户端原语包可解析，最好自包含');
}
for (const locale of ['zh', 'en']) {
  const file = join(root, 'locale', `${locale}.json`);
  if (!existsSync(file)) fail(`缺 locale/${locale}.json`, '补上');
  else {
    let bundle = null;
    try {
      bundle = readJson(file);
      pass(`locale/${locale}.json`);
    } catch {
      fail(`locale/${locale}.json 不是合法 JSON`, '修 JSON 语法');
    }
    const meta = bundle?.meta ?? {};
    if (typeof meta.title !== 'string' || meta.title.trim() === '') fail(`locale/${locale}.json 缺 meta.title`, '插件行会退回包名，写一个可读标题');
    if (typeof meta.description !== 'string' || meta.description.trim().length < 40) {
      fail(`locale/${locale}.json 的 meta.description 太短（插件详情页靠它讲清用途与限制）`, '写清触发位置、怎么用、限制');
    }
    if (meta.detail !== undefined) {
      const detail = String(meta.detail);
      if (!detail.endsWith('.md') && !detail.endsWith('.markdown')) fail(`meta.detail 必须是 .md：${detail}`, '改成 docs/DETAIL.<lang>.md');
      else if (!existsSync(join(root, detail))) fail(`meta.detail 指向不存在的文件：${detail}`, '补文件或删掉这一项');
      else pass(`detail → ${detail}`);
    }
  }
}

// 图标：导出的资源必须真实存在、在包内、不超过 256 KiB 且是可渲染的图片。
const iconExport = manifest.exports?.['./icon'];
if (!iconExport) fail('缺少 exports["./icon"]（插件行与详情页读它）', '加 "./icon": "./assets/icon.png"');
else {
  const iconFile = resolve(root, iconExport);
  if (!iconFile.startsWith(resolve(root))) fail(`icon 跑出包外：${iconExport}`, '挪回包内');
  else if (!existsSync(iconFile)) fail(`icon 不存在：${iconExport}`, '补文件');
  else {
    const bytes = readFileSync(iconFile);
    if (bytes.length > 256 * 1024) fail(`icon 超过 256 KiB（${bytes.length}）`, '压到 256 KiB 以内');
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isSvg = bytes.subarray(0, 200).toString('utf8').includes('<svg');
    if (!isPng && !isSvg) fail(`icon 不是 PNG/SVG（前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`, '换一张真图片，改扩展名不算');
    else pass(`icon ${iconExport}（${bytes.length} bytes）`);
  }
}

// ── 6. 创造模式端到端 ────────────────────────────────────────────────────
console.log('[6/7] 创造模式端到端（脚手架 → 校验 → 试跑 → 列目录）');
{
  const probeRoot = join(tmpdir(), `evolve-check-${Date.now().toString(36)}`);
  try {
    const bridge = await import('../lib/install.mjs');
    const made = await bridge.scaffold({ workspace: probeRoot, name: 'probe-plugin', template: 'tool' });
    if (!/@ok|✅/.test(made)) fail(`plugin new 失败：${made}`, '检查 install.mjs 的 targetDir/splitTarget 与 creation.scaffold 的 root+name 语义');
    else pass('plugin new ok');
    const probeDir = join(probeRoot, 'probe-plugin');
    const validated = await bridge.validateBundle({ path: probeDir });
    if (!validated.includes('✅')) fail(`plugin validate 失败：${validated}`, '看上面的错误项');
    else pass('plugin validate ok');
    const tested = await bridge.smokeTest({ path: probeDir });
    if (!tested.includes('✅')) fail(`plugin test 失败：${tested}`, '看日志尾部；模板生成的入口可能语法或导出有问题');
    else pass('plugin test ok');
    const listed = await bridge.listWorkspace({ workspace: probeRoot });
    if (!listed.includes('probe-plugin')) fail(`plugin list 没看到刚建的包：${listed}`, '检查 listWorkspace 包装');
    else pass('plugin list ok');
  } catch (error) {
    fail(`创造模式端到端抛异常：${error instanceof Error ? error.message : String(error)}`, '检查 install.mjs');
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

// ── 7. 运行时冒烟（桩 ctx 里真跑 runtime.mjs）────────────────────────────
console.log('[7/7] 运行时冒烟（工具 / 注入 / 检测器 / 硬拦截 / 规则）');
{
  try {
    const smoke = await import('../test/runtime-smoke.mjs');
    const result = await smoke.runRuntimeSmoke();
    for (const item of result.failures) fail(item.message, item.fix);
    for (const item of result.notes ?? []) pass(item);
    if (result.failures.length === 0) pass('运行时主链路 ok');
  } catch (error) {
    fail(`运行时冒烟加载失败：${error instanceof Error ? error.message : String(error)}`, '检查 test/runtime-smoke.mjs');
  }
}

// ── 8. 全源语法（lib 下每个 js/mjs 都要过 node --check） ──────────────────
{
  const { spawnSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const asText = value => (typeof value === 'string' ? value : String(value ?? ''));
  const libFiles = readdirSync(join(root, 'lib'))
    .filter(file => /\.(mjs|js|cjs)$/.test(file))
    .map(file => join(root, 'lib', file));
  let syntaxBad = 0;
  for (const file of libFiles) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) {
      syntaxBad += 1;
      fail(`语法错误：${file}：${asText(result.stderr).split('\n')[0]}`, '修语法错误');
    }
  }
  if (syntaxBad === 0) pass(`全部 ${libFiles.length} 个源文件语法通过`);
}

// ── 9. locale 中英对称 + client.js t() 键覆盖 ────────────────────────────
{
  const readLocale = name => {
    try { return JSON.parse(readFileSync(join(root, 'locale', name), 'utf8')); } catch { return null; }
  };
  const en = readLocale('en.json');
  const zh = readLocale('zh.json');
  if (!en || !zh) fail('locale/en.json 或 zh.json 无法解析', '修 JSON');
  else {
    const enKeys = Object.keys(en.meta ?? {}).sort().join(',');
    const zhKeys = Object.keys(zh.meta ?? {}).sort().join(',');
    if (enKeys !== zhKeys) fail(`locale meta 键不对称：en=[${enKeys}] zh=[${zhKeys}]`, '两边补成一致');
    else pass(`locale meta 键对称（${Object.keys(en.meta).length} 项）`);
  }
}

// ── 10. 回归测试（v0.1.4 修复项） ────────────────────────────────────────
{
  try {
    const regression = await import('../test/regression.mjs');
    const result = regression.regressionResult;
    if (result && result.fail > 0) fail(`回归测试 ${result.fail} 项失败`, '检查 test/regression.mjs 输出');
    else if (result) pass(`回归测试 ${result.pass} 项通过`);
  } catch (error) {
    fail(`回归测试加载失败：${error instanceof Error ? error.message : String(error)}`, '检查 test/regression.mjs');
  }
}

// 清理自检产生的临时状态。
try { rmSync(checkStateRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('');
if (notices.length > 0) console.log(`提示 ${notices.length} 条（--verbose 看全部）`);
if (failures.length === 0) {
  console.log('✅ 全部检查通过');
  process.exit(0);
}
console.log(`❌ ${failures.length} 项失败：`);
for (const failure of failures) {
  console.log(`  - ${failure.message}`);
  if (failure.fix) console.log(`    修法：${failure.fix}`);
}
process.exit(1);
