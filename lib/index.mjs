/**
 * profile 级入口（patch 行 `evolve-ptc-settings`）。
 *
 * 只做三件事：
 * 1. 归一化配置（Web 设置卡片、cordis patch、行配置都从这里进）。
 * 2. 派生并注册 `evolve-ptc` 预设 —— 派生是纯函数 + 磁盘读，失败会退回快照。
 * 3. 在宿主热更新时重新派生（签名变了才真重注册，避免白白打碎请求缓存）。
 *
 * 会话内的能力全在预设行 `evolve-runtime` 里，因此天然按会话隔离、随预设卸载而撤销。
 */
import { DEFAULTS, normalizeConfig, readOverrides } from './config.mjs';
import { definitionSignature, derivePreset, PRESET_ID } from './derive.mjs';
import { ensureDir, evolveRoot, statusLogFile } from './paths.mjs';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'evolve-ptc-settings';
export const inject = ['agentPresets'];

/**
 * 宿主自带的 schemastery：本包是 profile 里的 link 安装，裸 import 会从源码目录向上找
 * node_modules 而失败（真实安装路径不在 profile 下），所以显式从 profile 根 require。
 * 取不到就退回「没有 schema」—— 那种情况下预设照常注册，只是设置卡片不出现。
 */
function hostSchema() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profile = process.env.DSH_PROFILE || 'desktop';
    const root = process.env.DSH_PROFILE_DIR || join(home, 'profiles', profile);
    const loaded = createRequire(join(root, 'package.json'))('@deepseek-ai/schemastery');
    return loaded?.default ?? loaded;
  } catch {
    return null;
  }
}

const z = hostSchema();

/**
 * 配置模式。声明它不只是为了校验：宿主只给「有 schema 的条目」在 settings 文档里建命名空间，
 * 而客户端设置卡片靠 `configForms.whileServed(['evolve-ptc-settings'])` 才挂槽位 ——
 * 没有这个导出，客户端半边会静默地什么都不注册（这正是它一开始不出现的原因）。
 * 字段一律 `.volatile()`：值可在运行中变化，插件按次读取即可。
 */
export const Config = z ? z.object({
  environment: z.union(['auto', 'wsl', 'powershell', 'zsh', 'bash']).default(DEFAULTS.environment).volatile(),
  wslDistribution: z.string().default(DEFAULTS.wslDistribution).volatile(),
  shellExecutable: z.string().default(DEFAULTS.shellExecutable).volatile(),
  foregroundSeconds: z.number().step(1).min(5).max(600).default(DEFAULTS.foregroundSeconds).volatile(),
  processInjection: z.boolean().default(DEFAULTS.processInjection).volatile(),
  injectionEvery: z.number().step(1).min(1).max(20).default(DEFAULTS.injectionEvery).volatile(),
  stallSeconds: z.number().step(1).min(60).max(3600).default(DEFAULTS.stallSeconds).volatile(),
  correctiveBlocks: z.boolean().default(DEFAULTS.correctiveBlocks).volatile(),
  hardBlockAfter: z.number().step(1).min(2).max(8).default(DEFAULTS.hardBlockAfter).volatile(),
  rulesInjection: z.boolean().default(DEFAULTS.rulesInjection).volatile(),
  maxRules: z.number().step(1).min(1).max(20).default(DEFAULTS.maxRules).volatile(),
  creationMode: z.boolean().default(DEFAULTS.creationMode).volatile(),
  pluginWorkspace: z.string().default(DEFAULTS.pluginWorkspace).volatile(),
  autoRollback: z.boolean().default(DEFAULTS.autoRollback).volatile(),
  ledgerRetentionDays: z.number().step(1).min(0).max(365).default(DEFAULTS.ledgerRetentionDays).volatile(),
  snapshotBeforeInstall: z.boolean().default(DEFAULTS.snapshotBeforeInstall).volatile(),
}) : undefined;

/**
 * 生命周期日志：注册失败时最需要它（宿主只把 `TypeError` 写进一行诊断，上下文全丢）。
 * 超过 512KB 就轮转成一个 `.1`，不做复杂保留策略。
 */
function stamp(message) {
  try {
    const file = statusLogFile();
    ensureDir(dirname(file));
    try {
      if (statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`);
    } catch {
      // 文件还不存在。
    }
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, 'utf8');
  } catch {
    // 日志写不进去不影响主流程。
  }
}

export async function apply(ctx, rawConfig) {
  const log = ctx.logger ?? console;
  let release = null;
  let signature = null;
  let lastError = null;
  // rawConfig 是宿主的可变配置：字段 .volatile() 变化时不重启插件，只发
  // loader/volatile-update。每次 install 必须重新 normalize，不能复用
  // apply 开头的一次性快照，否则设置页改动要重启才生效（v0.1.3 实测）。
  let latestRaw = rawConfig;
  const currentConfig = () => normalizeConfig(latestRaw);
  const initial = currentConfig();
  stamp(`apply 开始 environment=${initial.environment} creationMode=${initial.creationMode} correctiveBlocks=${initial.correctiveBlocks} root=${evolveRoot()}`);
  stamp(`本地覆盖文件 ${readOverrides() && Object.keys(readOverrides()).length ? `已读取：${Object.keys(readOverrides()).join(',')}` : '无（可用 $DSH_HOME/evolve/config.json 覆盖）'}`);

  const install = async reason => {
    try {
      const config = currentConfig();
      const derived = await derivePreset(ctx, config, log);
      const nextSignature = definitionSignature(derived.definition);
      if (nextSignature === signature && release) return derived;
      const previous = release;
      // 先注册新的、成功后再释放旧的：注册失败时旧的注册必须原样保留，
      // 否则一次失败的 volatile 更新会让预设彻底消失（v0.1.3 实测）。
      const nextRelease = await ctx.agentPresets.register(derived.definition);
      release = nextRelease;
      if (previous && previous !== nextRelease) {
        try {
          await previous();
        } catch (error) {
          log.warn?.(`[evolve-ptc] 释放旧预设失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      signature = nextSignature;
      lastError = null;
      lastSource = derived.source;
      stamp(`预设 ${PRESET_ID} 已注册（来源 ${derived.source}，${reason}，${derived.definition.plugins.length} 行）`);
      log.info?.(`[evolve-ptc] 预设 ${PRESET_ID} 已注册（来源：${derived.source}，${reason}）`);
      // 注册成功不等于宿主把这一行认作可选项：把花名册与组成状态落盘，重启后一眼可查。
      try {
        const roster = typeof ctx.agentPresets.list === 'function' ? await ctx.agentPresets.list() : null;
        const row = Array.isArray(roster) ? roster.find(item => item?.id === PRESET_ID) : undefined;
        stamp(
          `花名册 ${Array.isArray(roster) ? `${roster.length} 项` : '读取不可用'}，${row ? '含' : '未含'} ${PRESET_ID}` +
            `${row?.broken ? `；broken=${row.broken}` : ''}`,
        );
        if (typeof ctx.agentPresets.compositionInventory === 'function') {
          const inventory = await ctx.agentPresets.compositionInventory();
          const mine = Array.isArray(inventory) ? inventory.find(item => item?.id === PRESET_ID) : undefined;
          if (mine) {
            const rows = Array.isArray(mine.rows) ? mine.rows : [];
            // FiberState 枚举：0 PENDING / 1 LOADING / 2 ACTIVE / 3 FAILED / 4 DISPOSED / 5 UNLOADING
            const unhealthy = rows.filter(item => item?.fiberState !== 2);
            stamp(
              `组成 ${rows.length} 行，broken=${mine.broken ?? '无'}，非 ACTIVE 行=` +
                `${unhealthy.map(item => `${item.moduleName}#${item.fiberState}`).join(',') || '无'}`,
            );
          }
        }
      } catch (error) {
        stamp(`花名册/组成读取失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      }
      // 客户端半边是否进了页面图：直接问宿主 clientModules 服务，比猜槽位可靠。
      try {
        const clientModules = ctx.get?.('clientModules');
        if (clientModules && typeof clientModules.graph === 'function') {
          const graph = clientModules.graph();
          const ids = (graph?.entries ?? []).map(entry => entry?.id).filter(Boolean);
          const mine = ids.includes('dsh-evolve-ptc');
          stamp(
            `客户端图 ${ids.length} 项，${mine ? '含' : '未含'} dsh-evolve-ptc` +
              `${mine && typeof clientModules.clientPath === 'function' ? `，bundle=${clientModules.clientPath('dsh-evolve-ptc')}` : ''}`,
          );
          const batches = (graph?.batches ?? []).map(batch => `${batch?.phase}:${(batch?.entries ?? []).length}`);
          stamp(`客户端批次 ${batches.join(' / ') || '无'}`);
        } else {
          stamp('clientModules 服务不可用');
        }
      } catch (error) {
        stamp(`客户端图读取失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      }
      for (const warning of derived.warnings) log.warn?.(`[evolve-ptc] ${warning}`);
      return derived;
    } catch (error) {
      lastError = error;
      // 注册失败不能把 profile 拖下水：保留上一次成功的注册，只记日志。
      stamp(`派生/注册 ${PRESET_ID} 失败（${reason}）：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      log.error?.(`[evolve-ptc] 派生/注册 ${PRESET_ID} 失败（${reason}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  await install('apply');

  ctx.effect(() => () => {
    const current = release;
    release = null;
    if (current) {
      try {
        const result = current();
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch {
        // 已回收。
      }
    }
  });

  // 宿主热更新（npm link / 设置改动）后重新派生：签名没变就什么都不做。
  // rawConfig 的 .volatile() 字段是宿主可变对象上的 getter，重新 normalize 即可读到新值；
  // 若回调显式带了新的 config 对象，优先用它。
  try {
    ctx.on('loader/volatile-update', (payload) => {
      const next = payload?.config ?? payload?.value ?? (payload && typeof payload === 'object' ? payload : null);
      if (next && typeof next === 'object') latestRaw = next;
      void install('volatile-update');
    });
  } catch (error) {
    log.warn?.(`[evolve-ptc] 挂载 loader/volatile-update 失败：${String(error?.message ?? error)}`);
  }

  // 诊断：模块级引用，别往 ctx 上挂东西（Cordis 的 ctx 是代理，属性写入不可靠）。
  lastState = { presetId: PRESET_ID, registered: Boolean(release), source: lastSource, lastError: lastError ? String(lastError.message ?? lastError) : null };

  // 注意：Cordis 会把 apply 的返回值当成 effect 收集，返回普通对象会抛 TypeError: Invalid effect。
  // 因此这里不返回任何东西；诊断走导出的 status()。
}

let lastState = { presetId: PRESET_ID, registered: false, source: null, lastError: null };
let lastSource = null;

/** 给 doctor 之类的外部诊断用：最近一次 apply 的结果。 */
export function status() {
  return { ...lastState };
}

