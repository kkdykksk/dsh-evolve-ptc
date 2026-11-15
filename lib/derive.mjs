/**
 * 预设派生：把宿主自带的官方 PTC 预设行「原样继承 + 定向增强」，得到 `evolve-ptc`。
 *
 * 与 deep-ptc 的做法同构（不写死官方行）：官方行升级了，我们跟着走；只有 persona、
 * 运行时行、创造模式增量行是我们自己的。解析失败时退回到上一次成功的快照，保证
 * 插件装坏也不会让 profile 起不来。
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PERSONA, CREATIVE_LINE } from './persona.mjs';
import { runtimeConfig } from './config.mjs';
import { createResolver } from './resolve.mjs';
import { snapshotFile, evolveRoot, ensureDir } from './paths.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

export const PRESET_ID = 'evolve-ptc';
export const PRESET_NAME = '进化 PTC 模式';
export const PRESET_ORDER = 7;
export const RUNTIME_ROW_ID = 'evolve-runtime';
export const PRESET_DESCRIPTION =
  'PTC 的进化版：可验证的电脑操作契约、只记证据的任务账本、运行期自纠错与规则沉淀，外加自建并安装插件的创造模式。';

const OFFICIAL_PRESET_ID = 'ptc';
const PTC_SPEC = '@deepseek-ai/dsh-web-app/presets/ptc.patch.yml';
const CORDIS_SPEC = '@deepseek-ai/dsh-web-app/presets/cordis.patch.yml';
const CORDIS_PRESET_ID = 'cordis';
const CORDIS_TOOL_SPEC = '@deepseek-ai/dsh-tool-cordis/package.json';

const MANAGER_ROW_IDS = ['tool-plugin-manager', 'tool-plugin-market'];
const CREATION_ROW_IDS = new Set(['tool-cordis', 'skill-filesystem', 'tool-skill', 'present', ...MANAGER_ROW_IDS]);

const describe = error => (error instanceof Error ? error.message : String(error));

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** `!!js` 标量在派生结果里保留为 `{ __jsExpr }`，由宿主的 prepareProfileEntries 求值。 */
export function jsExprSchema(yaml) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: data => typeof data === 'string',
    construct: data => ({ __jsExpr: data }),
  });
  return yaml.JSON_SCHEMA.extend(JsExpr);
}

/**
 * 从一份 patch 文档里取出指定 id 的预设声明。
 * 文档形状：`[{ insert: [{ id, name, config: { id, order, plugins } }] }]`；
 * 也接受已经是预设定义本身的文档。
 */
export function parsePatchDocument(yaml, source, wantId) {
  const document = yaml.load(source, { schema: jsExprSchema(yaml) });
  if (document && typeof document === 'object' && !Array.isArray(document) && Array.isArray(document.plugins)) {
    if (document.id === wantId) return document;
  }
  const rows = [];
  const pushRows = value => {
    if (!Array.isArray(value)) return;
    for (const row of value) if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
  };
  if (Array.isArray(document)) {
    for (const layer of document) {
      if (!layer || typeof layer !== 'object') continue;
      if (Array.isArray(layer.insert)) pushRows(layer.insert);
      else if (layer.insert && typeof layer.insert === 'object') rows.push(layer.insert);
      pushRows(layer.plugins);
    }
  }
  const declarations = rows.map(row => row.config).filter(config => config && Array.isArray(config.plugins));
  const found = declarations.find(config => config.id === wantId);
  if (!found) {
    const seen = declarations.map(config => JSON.stringify(config.id ?? null)).join(', ');
    throw new Error(`文档里没有 id="${wantId}" 的预设声明${seen ? `（找到 ${seen}）` : ''}`);
  }
  return found;
}

/** 稳定序列化：键排序，用于比较派生结果是否变化（避免无意义地重注册预设）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function definitionSignature(definition) {
  return createHash('sha1').update(stableStringify(definition)).digest('hex');
}

function readSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile(), 'utf8'));
    const definition = parsed && parsed.definition;
    if (definition && Array.isArray(definition.plugins)) return definition;
  } catch {
    // 没有快照是正常状态（第一次装）。
  }
  return null;
}

function persistSnapshot(definition, note) {
  try {
    const current = readSnapshot();
    if (current && stableStringify(current) === stableStringify(definition)) return;
    ensureDir(evolveRoot());
    writeFileSync(
      snapshotFile(),
      `${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), presetId: OFFICIAL_PRESET_ID, definition }, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    note(`写预设快照失败（不影响运行）：${describe(error)}`);
  }
}

function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** `@deepseek-ai/dsh-agent-preset` 随包携带的 skills 目录（dsh-doc 等随宿主发布）。 */
function resolvePresetSkillsDirectory(resolver) {
  const packageFile = resolver.resolve('@deepseek-ai/dsh-agent-preset/package.json');
  if (!packageFile) return null;
  const skills = join(dirname(packageFile), 'skills');
  return existsSync(skills) ? skills : null;
}

/** 从宿主「创造模式」预设里取一行作为参考；取不到返回 null。 */
function readCordisRows(ctx, resolver, yaml, note) {
  const parse = source => {
    const document = yaml.load(source, { schema: jsExprSchema(yaml) });
    const rows = [];
    const pushRows = value => {
      if (!Array.isArray(value)) return;
      for (const row of value) if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    };
    if (Array.isArray(document)) {
      for (const layer of document) {
        if (!layer || typeof layer !== 'object') continue;
        if (Array.isArray(layer.insert)) pushRows(layer.insert);
        else if (layer.insert && typeof layer.insert === 'object') rows.push(layer.insert);
        pushRows(layer.plugins);
      }
    }
    const declaration = rows.map(row => row.config).find(config => config && config.id === CORDIS_PRESET_ID && Array.isArray(config.plugins));
    return declaration ? new Map(declaration.plugins.filter(row => row && row.id).map(row => [row.id, row])) : null;
  };
  let text = null;
  try {
    const document = ctx?.agentPresets?.readDocument?.(CORDIS_PRESET_ID);
    if (document && typeof document.content === 'string' && document.content.trim()) text = document.content;
    // readDocument 是同步契约；若宿主改成 Promise 也能接住。
    if (text && typeof text.then === 'function') text = null;
  } catch (error) {
    note(`读取创造模式预设失败（将使用内置增量）：${describe(error)}`);
  }
  if (!text) text = process.env.EVOLVE_PTC_CORDIS ? resolver.readPath(process.env.EVOLVE_PTC_CORDIS) : null;
  if (!text) text = resolver.readText(CORDIS_SPEC);
  if (!text) return null;
  try {
    return parse(text);
  } catch (error) {
    note(`解析创造模式预设失败（将使用内置增量）：${describe(error)}`);
    return null;
  }
}

/**
 * 创造模式增量行：让本模式的会话能「检查宿主 API、写插件、装插件、体检」。
 * 官方 cordis 预设是权威来源，因此优先照抄它的行；宿主没发布时才用内置等价行。
 */
function applyCreationAdditions(plugins, config, environment) {
  const { ctx, resolver, yaml, note } = environment;
  const hasProfileContext = Boolean(safeGet(ctx, 'profileContext'));
  const cordisRows = yaml ? readCordisRows(ctx, resolver, yaml, note) : null;

  // 1. 插件管理器：安装/卸载/升级 bundle 的唯一官方通道。
  for (const id of MANAGER_ROW_IDS) {
    const row = plugins.find(candidate => candidate && candidate.id === id);
    if (!row) {
      note(`官方 PTC 行里没有 ${id}，创造模式无法安装插件（跳过）`);
      continue;
    }
    row.disabled = !hasProfileContext;
  }

  // 2. tool-cordis：读宿主服务/事件/配置/槽位的只读通道（cordis_inspect_*）。
  const hasCordisTool = plugins.some(row => row && String(row.name ?? '').includes('dsh-tool-cordis'));
  if (!hasCordisTool) {
    if (!resolver.resolve(CORDIS_TOOL_SPEC)) {
      note('宿主未安装 @deepseek-ai/dsh-tool-cordis，跳过宿主自省工具（创造模式仍可用文件与命令完成大部分工作）');
    } else {
      const reference = cordisRows?.get('tool-cordis');
      const row = reference ? clone(reference) : { id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' };
      row.id = row.id || 'tool-cordis';
      const anchor = plugins.findIndex(candidate => candidate && candidate.id === 'tool-executor-ptc');
      if (anchor >= 0) plugins.splice(anchor + 1, 0, row);
      else plugins.push(row);
    }
  }

  // 3. skill-filesystem：补上随宿主发布的 skills 目录，让 dsh-doc 这类技能可被 load_skill 命中。
  const skillRow = plugins.find(row => row && row.id === 'skill-filesystem');
  if (skillRow) {
    const reference = cordisRows?.get('skill-filesystem');
    const referenceConfig = reference && reference.config ? clone(reference.config) : {};
    const current = skillRow.config && typeof skillRow.config === 'object' ? clone(skillRow.config) : {};
    const directories = [];
    const push = value => {
      if (!value) return;
      const signature = JSON.stringify(value);
      if (directories.some(existing => JSON.stringify(existing) === signature)) return;
      directories.push(value);
    };
    for (const value of Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []) push(value);
    for (const value of Array.isArray(referenceConfig.customSkillDirs) ? referenceConfig.customSkillDirs : []) push(value);
    const local = resolvePresetSkillsDirectory(resolver);
    if (local) push(local);
    if (directories.length > 0) skillRow.config = { ...current, customSkillDirs: directories };
  }

  // 4. 创造模式的身份说明写进 persona 前缀（composePersonaPrefix 负责），这里只补行。
  for (const id of ['tool-skill', 'present']) {
    if (!plugins.some(row => row && row.id === id)) {
      const reference = cordisRows?.get(id);
      if (reference) plugins.push(clone(reference));
      else if (id === 'tool-skill') plugins.push({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' });
      else note('官方行里没有 present 行，跳过（不影响创造模式）');
    }
  }
  void CREATION_ROW_IDS;
  void config;
}

export function composePersonaPrefix(config) {
  const prefix = [PERSONA];
  if (config.creationMode) prefix.push('', CREATIVE_LINE);
  return prefix.join('\n');
}

/**
 * 用官方行 + 本插件的行为契约组装 preset 定义。
 * 纯函数（不碰磁盘），便于 `scripts/check.mjs` 做快照一致性校验。
 */
export function composeDefinition(official, config, environment) {
  const plugins = (Array.isArray(official?.plugins) ? clone(official.plugins) : []).filter(
    row => row && typeof row === 'object' && row.id !== RUNTIME_ROW_ID,
  );
  const personaRow = plugins.find(row => row.id === 'persona' || String(row.name ?? '').includes('dsh-persona'));
  const prefix = composePersonaPrefix(config);
  if (personaRow) personaRow.config = { ...(personaRow.config ?? {}), prefix };
  else plugins.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } });

  if (config.creationMode) applyCreationAdditions(plugins, config, environment);

  plugins.push({ id: RUNTIME_ROW_ID, name: 'dsh-evolve-ptc/runtime', config: runtimeConfig(config) });

  return {
    id: PRESET_ID,
    name: PRESET_NAME,
    description: PRESET_DESCRIPTION,
    order: PRESET_ORDER,
    plugins,
  };
}

/**
 * 派生入口：宿主花名册文档 → 随包补丁文件 → 上次成功的快照。
 * 永不抛「找不到官方预设」以外的异常；任何一步失败都只降级。
 */
export async function derivePreset(ctx, config, logger) {
  const warnings = [];
  const note = message => {
    warnings.push(message);
    try {
      logger?.warn?.(`[evolve-ptc] ${message}`);
    } catch {
      // 日志失败不影响派生。
    }
  };
  const resolver = createResolver(ctx);
  const yaml = await resolver.loadYaml();
  if (!yaml) throw new Error('js-yaml 不可用：无法解析官方预设文档，请确认 profile 里装有 js-yaml');

  let definition = null;
  let source = null;

  try {
    const document = await ctx?.agentPresets?.readDocument?.(OFFICIAL_PRESET_ID);
    if (document && typeof document.content === 'string' && document.content.trim()) {
      definition = parsePatchDocument(yaml, document.content, OFFICIAL_PRESET_ID);
      source = `agentPresets.readDocument(${OFFICIAL_PRESET_ID})`;
    }
  } catch (error) {
    note(`readDocument(${OFFICIAL_PRESET_ID}) 失败：${describe(error)}`);
  }

  if (!definition) {
    // 自检/离线校验可以显式指定上游文档（asar 里的路径只有 Electron 能读）。
    const overridden = process.env.EVOLVE_PTC_UPSTREAM ? resolver.readPath(process.env.EVOLVE_PTC_UPSTREAM) : null;
    const text = overridden ?? resolver.readText(PTC_SPEC);
    if (text) {
      try {
        definition = parsePatchDocument(yaml, text, OFFICIAL_PRESET_ID);
        source = PTC_SPEC;
      } catch (error) {
        note(`解析 ${PTC_SPEC} 失败：${describe(error)}`);
      }
    } else {
      note(`定位不到 ${PTC_SPEC}（当前解析根：${resolver.roots.join(' | ')}）`);
    }
  }

  if (!definition) {
    const snapshot = readSnapshot();
    if (!snapshot) throw new Error('既读不到官方 PTC 预设，也没有可用快照：无法派生 evolve-ptc');
    note('退回到本地快照的官方 PTC 行（可能落后于宿主版本）');
    definition = snapshot;
    source = 'snapshot';
  } else {
    persistSnapshot(definition, note);
  }

  const composed = composeDefinition(definition, config, { ctx, resolver, yaml, note });
  return { definition: composed, official: definition, source, warnings };
}

export const constants = { PRESET_ID, PRESET_NAME, PRESET_ORDER, RUNTIME_ROW_ID, OFFICIAL_PRESET_ID, PTC_SPEC, CORDIS_SPEC };
