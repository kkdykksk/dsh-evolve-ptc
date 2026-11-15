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
import { normalizeConfig } from './config.mjs';
import { definitionSignature, derivePreset, PRESET_ID } from './derive.mjs';
import { ensureDir, evolveRoot, statusLogFile } from './paths.mjs';
import { appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = 'evolve-ptc-settings';
export const inject = ['agentPresets'];

/**
 * 生命周期日志：注册失败时最需要它（宿主只把 `TypeError` 写进一行诊断，上下文全丢）。
 * 超过 512KB 就轮转成一个 `.1`，不做复杂保留策略。
 */
function stamp(message) {
  try {
    const file = statusLogFile();
    ensureDir(dirname(file));
    try {
      if (statSync(file).size > 512 * 1024) appendFileSync(`${file}.1`, '', 'utf8');
    } catch {
      // 文件还不存在。
    }
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, 'utf8');
  } catch {
    // 日志写不进去不影响主流程。
  }
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = ctx.logger ?? console;
  let release = null;
  let signature = null;
  let lastError = null;
  stamp(`apply 开始 environment=${config.environment} creationMode=${config.creationMode} root=${evolveRoot()}`);

  const install = async reason => {
    try {
      const derived = await derivePreset(ctx, config, log);
      const nextSignature = definitionSignature(derived.definition);
      if (nextSignature === signature && release) return derived;
      const previous = release;
      release = null;
      if (previous) {
        try {
          await previous();
        } catch (error) {
          log.warn?.(`[evolve-ptc] 释放旧预设失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      release = await ctx.agentPresets.register(derived.definition);
      signature = nextSignature;
      lastError = null;
      lastSource = derived.source;
      stamp(`预设 ${PRESET_ID} 已注册（来源 ${derived.source}，${reason}，${derived.definition.plugins.length} 行）`);
      log.info?.(`[evolve-ptc] 预设 ${PRESET_ID} 已注册（来源：${derived.source}，${reason}）`);
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
  try {
    ctx.on('loader/volatile-update', () => {
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
