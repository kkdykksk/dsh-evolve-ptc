/**
 * 配置归一化。`cordis.patch.yml` 里的 `evolve-ptc-settings` 行、`evolve-runtime` 行、
 * 以及 Web 设置卡片保存下来的值，都经过这里变成一份确定的、可 JSON 化的配置。
 *
 * 原则：每个键都必须是「有默认值 + 有边界」的，因为运行时（检测器、注入、创造模式）
 * 会无条件信任这里给出的形状。
 *
 * 本地覆盖文件：`$DSH_HOME/evolve/config.json`。**它优先级最高**，因为 `cordis.patch.yml`
 * 是宿主自己的文件（每次退出/重启都会按内存里的组合整体重写，手写的行会被丢掉），
 * 而这个文件只在启动时被读一次，宿主从不改写它。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { evolveRoot } from './paths.mjs';
export const DEFAULTS = Object.freeze({
  /** 执行环境：auto 按平台挑；其余透传语义（v1 只用于提示，不改写官方 shell 行）。 */
  environment: 'auto',
  wslDistribution: '',
  shellExecutable: '',
  /** 前台命令超过这个秒数就该转后台（persona 与检测器共用同一口径）。5–600。 */
  foregroundSeconds: 30,
  /** 进程可见性注入：每步把账本摘要写进系统提示。 */
  processInjection: true,
  /** 每 N 步刷新一次注入文本（1 = 每步；过大则纠错块也会变迟钝）。 */
  injectionEvery: 1,
  /** 一个阶段原地不动超过这个秒数视为停滞。>=60。 */
  stallSeconds: 240,
  /** 命中检测器时是否注入纠错块。 */
  correctiveBlocks: true,
  /** 同一检测器连续命中多少次升级为硬拦截（需先 reflect）。2–8。 */
  hardBlockAfter: 3,
  /** 规则库注入开关与条数上限。 */
  rulesInjection: true,
  maxRules: 8,
  /** 创造模式：允许用 evolve 工具脚手架/校验/试跑/安装/回滚插件。 */
  creationMode: true,
  /** 插件工作区（脚手架输出目录）。空 = `$DSH_HOME/evolve/workspace`。 */
  pluginWorkspace: '',
  /** 安装失败或 doctor 不健康时自动回滚。 */
  autoRollback: true,
  /** 账本保留天数（启动时清理）。 */
  ledgerRetentionDays: 14,
  /** 插件安装前是否自动快照 profile（package.json + cordis.patch.yml）。 */
  snapshotBeforeInstall: true,
});

const clampInt = (value, min, max, fallback) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

const text = (value, fallback) => (typeof value === 'string' ? value : fallback);

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * 取出配置字段的真实值：声明为 schemastery `.volatile()` 的字段在插件里拿到的是
 * `{ get(): T }` 包装，而不是裸值。这里统一解包，让 normalizeConfig 对两种来源都成立。
 */
function plain(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** 本地覆盖文件的路径：`$DSH_HOME/evolve/config.json`。 */
export function overrideFile() {
  return join(evolveRoot(), 'config.json');
}

/**
 * 读本地覆盖文件。文件不存在、不是 JSON 对象、或读不动时一律返回空对象 —— 覆盖是
 * 可选增强，绝不能因为它让整个插件起不来。
 */
export function readOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(overrideFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 归一化任意来源的配置对象；未知键被丢弃，坏值退回默认值。 */
export function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  // 覆盖文件最后合并：它的键覆盖 schema 默认值与 patch 行里写明的值。
  const overrides = readOverrides();
  const raw = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = plain(source[key]);
    raw[key] = value === undefined ? plain(overrides[key]) : value;
    if (overrides[key] !== undefined && overrides[key] !== null) raw[key] = plain(overrides[key]);
  }
  const environment = ['auto', 'wsl', 'powershell', 'zsh', 'bash'].includes(raw.environment)
    ? raw.environment
    : DEFAULTS.environment;
  return {
    environment,
    wslDistribution: text(raw.wslDistribution, DEFAULTS.wslDistribution).trim(),
    shellExecutable: text(raw.shellExecutable, DEFAULTS.shellExecutable).trim(),
    foregroundSeconds: clampInt(raw.foregroundSeconds, 5, 600, DEFAULTS.foregroundSeconds),
    processInjection: bool(raw.processInjection, DEFAULTS.processInjection),
    injectionEvery: clampInt(raw.injectionEvery, 1, 20, DEFAULTS.injectionEvery),
    stallSeconds: clampInt(raw.stallSeconds, 60, 3600, DEFAULTS.stallSeconds),
    correctiveBlocks: bool(raw.correctiveBlocks, DEFAULTS.correctiveBlocks),
    hardBlockAfter: clampInt(raw.hardBlockAfter, 2, 8, DEFAULTS.hardBlockAfter),
    rulesInjection: bool(raw.rulesInjection, DEFAULTS.rulesInjection),
    maxRules: clampInt(raw.maxRules, 1, 20, DEFAULTS.maxRules),
    creationMode: bool(raw.creationMode, DEFAULTS.creationMode),
    pluginWorkspace: text(raw.pluginWorkspace, DEFAULTS.pluginWorkspace).trim(),
    autoRollback: bool(raw.autoRollback, DEFAULTS.autoRollback),
    ledgerRetentionDays: clampInt(raw.ledgerRetentionDays, 0, 365, DEFAULTS.ledgerRetentionDays),
    snapshotBeforeInstall: bool(raw.snapshotBeforeInstall, DEFAULTS.snapshotBeforeInstall),
  };
}

/** 运行时行只关心行为相关的键；预设派生额外关心执行环境键。 */
export function runtimeConfig(config) {
  return {
    foregroundSeconds: config.foregroundSeconds,
    processInjection: config.processInjection,
    injectionEvery: config.injectionEvery,
    stallSeconds: config.stallSeconds,
    correctiveBlocks: config.correctiveBlocks,
    hardBlockAfter: config.hardBlockAfter,
    rulesInjection: config.rulesInjection,
    maxRules: config.maxRules,
    creationMode: config.creationMode,
    pluginWorkspace: config.pluginWorkspace,
    autoRollback: config.autoRollback,
    ledgerRetentionDays: config.ledgerRetentionDays,
    snapshotBeforeInstall: config.snapshotBeforeInstall,
    environment: config.environment,
    wslDistribution: config.wslDistribution,
    shellExecutable: config.shellExecutable,
  };
}
