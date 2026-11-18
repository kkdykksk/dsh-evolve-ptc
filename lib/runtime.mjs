/**
 * 会话内运行时（预设行 `evolve-runtime`）：这是本插件与 deep-ptc 的真正差异所在。
 *
 * 三件事：
 * 1. `evolve` 工具 —— 账本 / 自检 / 反思 / 规则 / 临时重写检测器。
 * 2. 每步注入 —— `[EVOLVE 进程]` 段（计划进度 + 最近教训 + 规则）与 `[EVOLVE 纠错]`
 *    块（检测器命中时）。注入走 systemPrompt 的 section，天然只作用于本会话。
 * 3. 检测器 —— 从会话事件与工具回执里读近期活动，命中就记账、注入纠错，连续命中
 *    升级为「只允许 evolve」的软硬拦截（硬拦截用 tools.guard，签名不匹配时自动降级）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeConfig } from './config.mjs';
import { createResolver } from './resolve.mjs';
import {
  appendLedger,
  detect,
  ledgerState,
  loadRules,
  nowIso,
  pruneLedgers,
  rankRules,
  recordLesson,
  markRuleOutcome,
  revertRules,
  scopeForCwd,
  WRITE_TOOLS,
} from './state.mjs';
import { evolveRoot, workspaceDir } from './paths.mjs';

export const name = 'evolve-runtime';
// 只声明真正必需的服务。Cordis 里直接访问未 inject 的服务是**抛错**而不是 undefined
// （真机报过 "cannot get property commands without inject"），所以可选服务一律走
// `ctx.get('名称')` 取值：拿不到就跳过，绝不让整行挂不起来。
export const inject = ['tools', 'systemPrompt'];

const SECTION_NAME = 'evolve-ptc:process';
const SECTION_ORDER = 10196;
const TOOL_NAME = 'evolve';
const MAX_RESULT = 4096;
/**
 * 硬拦截的有效期。检测器是「看最近活动」的无状态判断，同一批失败会在随后每一步重复命中；
 * 拦截因此必须有出口：到点自动解除，绝不把会话永久锁死（v0.1.0 就是栽在这里）。
 */
const BLOCK_MS = 120_000;
const ACTIVITY_LIMIT = 40;

const describe = error => (error instanceof Error ? error.message : String(error));

const clip = (value, limit) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const STATUS_MARK = { done: '✔', failed: '✘', blocked: '!', todo: '○', doing: '▶', note: '·' };

function markOf(status) {
  return STATUS_MARK[String(status ?? 'todo').toLowerCase()] ?? '·';
}

function renderPlan(state) {
  if (!state.hasPlan || state.steps.length === 0) return '';
  const lines = state.steps.map(step => `  ${markOf(step.status)} ${step.id}. ${clip(step.title, 60)}`);
  return [`计划 ${state.done}/${state.total}`, ...lines].join('\n');
}

/** 从会话事件里尽力还原「最近用过哪些工具、成功与否」。拿不到就返回空数组。 */
function readSessionActivity(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return [];
  const calls = [];
  const results = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type ?? '');
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (type === 'tool/call') {
      const callId = data.callId ?? data.id ?? data.call?.id;
      const toolName = data.name ?? data.call?.name ?? data.tool ?? data.toolName;
      if (typeof toolName === 'string') calls.push({ id: callId, name: toolName, args: data.args ?? data.call?.input, at: event.at ?? event.time });
    } else if (type === 'tool/result') {
      const callId = data.callId ?? data.id ?? data.call?.id;
      const failed = Boolean(data.error ?? data.isError ?? data.result?.isError ?? data.outcome === 'error');
      const errorText = data.error?.message ?? data.result?.error ?? data.message;
      if (callId !== undefined) results.set(callId, { ok: !failed, error: errorText });
      else if (calls.length > 0) calls[calls.length - 1].ok = !failed;
    }
  }
  const activity = [];
  for (const call of calls.slice(-ACTIVITY_LIMIT)) {
    const result = call.id === undefined ? undefined : results.get(call.id);
    activity.push({ name: call.name, args: call.args, ok: result ? result.ok : call.ok, error: result?.error, at: call.at });
  }
  return activity;
}

function sessionKeyOf(agent, exec) {
  const candidates = [
    agent?.session?.id,
    agent?.sessionId,
    agent?.id,
    exec?.agent?.session?.id,
    exec?.session?.id,
  ];
  for (const value of candidates) if (typeof value === 'string' && value !== '') return value;
  return 'unbound';
}

function resolveCwd(agent, exec) {
  const candidates = [exec?.cwd, agent?.session?.cwd, agent?.cwd, process.cwd()];
  for (const value of candidates) if (typeof value === 'string' && value.trim() !== '') return value;
  return process.cwd();
}

const looksLikeFailure = result => {
  if (!result || typeof result !== 'object') return false;
  if (result.isError === true || result.error) return true;
  const status = String(result.status ?? result.outcome ?? '');
  return status === 'error' || status === 'failed';
};

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = ctx.logger ?? console;
  const agentRef = { current: null };
  const activityFromListener = [];
  const strikes = new Map();
  // 每个检测器上次命中时的证据指纹：只有证据变了才算新的一次命中，
  // 否则同一次失败会在每一步被重复计数（v0.1.0 的致命 bug）。
  const hitEvidence = new Map();
  const block = { active: false, code: '', since: 0, hits: 0, cleared: 0 };
  let sectionDispose = null;
  let lastSectionText = '';
  let ruleSignature = '';
  let cachedRules = [];
  let lastCorrection = null;
  let toolDispose = null;

  function clearBlock(reason) {
    if (!block.active) return;
    block.active = false;
    block.code = '';
    block.hits = 0;
    block.since = 0;
    block.cleared = Date.now();
    log.warn?.(`[evolve-ptc] 硬拦截解除：${reason}`);
  }

  try {
    if (config.ledgerRetentionDays > 0) pruneLedgers(config.ledgerRetentionDays);
  } catch {
    // 清理失败不影响会话。
  }

  const sessionId = () => sessionKeyOf(agentRef.current, null);
  const scope = () => scopeForCwd(resolveCwd(agentRef.current, null));

  function refreshRules() {
    try {
      const store = loadRules(scope());
      const picked = rankRules(store.rules ?? [], config.maxRules);
      const signature = picked.map(rule => rule.id).join(',');
      if (signature !== ruleSignature) {
        ruleSignature = signature;
        cachedRules = picked;
      }
      return store;
    } catch {
      cachedRules = [];
      return { version: 0, rules: [] };
    }
  }

  function activity() {
    const fromSession = readSessionActivity(agentRef.current);
    if (fromSession.length > 0) return fromSession;
    return activityFromListener.slice(-ACTIVITY_LIMIT);
  }

  // ── 每步注入 ────────────────────────────────────────────────────────────
  function buildSectionText() {
    if (!config.processInjection) return '';
    const id = sessionId();
    if (id === 'unbound') return '';
    const state = ledgerState(id, 8);
    refreshRules();
    const parts = ['[EVOLVE 进程]'];
    const plan = renderPlan(state);
    if (plan) parts.push(plan);
    else parts.push('计划：未登记（开工先 evolve({action:"plan", steps:[...]})）');
    if (state.phase) parts.push(`阶段：${clip(state.phase, 100)}`);
    if (state.lessons.length > 0) parts.push(`最近教训：${clip(state.lessons[state.lessons.length - 1], 160)}`);
    if (config.rulesInjection && cachedRules.length > 0) {
      parts.push(`规则（${cachedRules.length}）：\n${cachedRules.slice(0, 5).map(rule => `  - ${clip(rule.text, 120)}`).join('\n')}`);
    }
    if (block.active) {
      const left = Math.max(0, Math.round((block.since + BLOCK_MS - Date.now()) / 1000));
      parts.push(
        `【硬拦截】检测器 ${block.code} 连续命中 ${block.hits} 次：写操作已暂停（读操作照常），先 evolve({action:"reflect", lesson:"..."}) 写下根因与下一步；${left}s 后自动解除。`,
      );
    }
    if (lastCorrection && lastCorrection.at > Date.now() - 15 * 60 * 1000) {
      parts.push(`【纠错】${lastCorrection.code}：${clip(lastCorrection.detail, 320)}`);
    }
    const text = parts.filter(Boolean).join('\n');
    return clip(text, 1200);
  }

  function installSection() {
    const text = buildSectionText();
    if (text === lastSectionText && sectionDispose) return;
    lastSectionText = text;
    try {
      if (sectionDispose) {
        try {
          sectionDispose();
        } catch {
          // 旧段可能已被宿主回收。
        }
      }
      sectionDispose = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => lastSectionText,
      });
    } catch (error) {
      sectionDispose = null;
      log.warn?.(`[evolve-ptc] 注入 [EVOLVE 进程] 失败：${describe(error)}`);
    }
  }

  // ── 检测 ────────────────────────────────────────────────────────────────
  function runDetectors({ record = true } = {}) {
    const recent = activity();
    const last = recent[recent.length - 1];
    // 最近一次动作成功了 = 有进展：清零升级计数，别让一次历史失败把会话永久顶在悬崖边。
    if (last && last.ok !== false && strikes.size > 0) strikes.clear();
    const hits = detect({
      activity: recent,
      config,
      softFailures: 0,
    });
    for (const hit of hits) {
      // 证据指纹：这次命中来自「哪一批活动」。指纹没变说明是同一次失败在后续每一步被重复看见，
      // 不该再算一次升级（v0.1.0 每步都自增，三步后就把除 evolve 外的工具全锁死）。
      const evidence = `${hit.code}|${last?.at ?? 0}|${last?.name ?? ''}|${recent.length}`;
      const fresh = hitEvidence.get(hit.code) !== evidence;
      hitEvidence.set(hit.code, evidence);
      const count = fresh ? (strikes.get(hit.code) ?? 0) + 1 : (strikes.get(hit.code) ?? 1);
      strikes.set(hit.code, count);
      if (record && fresh) {
        try {
          appendLedger(sessionId(), { k: 'signal', code: hit.code, detail: clip(hit.detail, 400), count });
        } catch {
          // 记账失败不影响注入。
        }
      }
      lastCorrection = { code: hit.code, detail: hit.detail, at: Date.now() };
      // 只有「同一工具连续失败」这种无歧义信号才升级为硬拦截；其余命中只注入纠错提示。
      if (hit.code === 'repeatFailure' && fresh && count >= config.hardBlockAfter && !block.active) {
        block.active = true;
        block.code = hit.code;
        block.since = Date.now();
        block.hits = count;
        log.warn?.(`[evolve-ptc] 检测器 ${hit.code} 连续命中 ${count} 次，已升级为硬拦截（只拦写操作，${BLOCK_MS / 1000}s 后自动解除）`);
      } else if (block.active) {
        block.hits = Math.max(block.hits, count);
      }
    }
    if (hits.length > 0) installSection();
    return hits;
  }

  // ── evolve 工具的实现 ───────────────────────────────────────────────────
  function renderStatus(exec) {
    const id = sessionKeyOf(agentRef.current, exec);
    const state = ledgerState(id, 8);
    const store = loadRules(scope());
    refreshRules();
    const lines = [];
    lines.push(`# EVOLVE 状态`);
    lines.push(`会话：${id}`);
    lines.push(`作用域：${scope()}（规则 ${store.rules?.length ?? 0} 条，版本 v${store.version ?? 0}）`);
    lines.push(`执行环境：${config.environment}${config.shellExecutable ? ` / ${config.shellExecutable}` : ''}`);
    lines.push(`前台阈值：${config.foregroundSeconds}s · 停滞阈值：${config.stallSeconds}s · 创造模式：${config.creationMode ? '开' : '关'}`);
    const plan = renderPlan(state);
    lines.push(plan || '计划：未登记');
    if (state.phase) lines.push(`阶段：${state.phase}`);
    if (state.lastNoteAt) lines.push(`最近记账：${state.lastNoteAt}`);
    if (cachedRules.length > 0) {
      lines.push(`规则：`);
      for (const rule of cachedRules) lines.push(`  - [${rule.id}] ${clip(rule.text, 120)}（赢 ${rule.wins ?? 0}/用 ${rule.uses ?? 0}）`);
    }
    if (block.active) lines.push(`硬拦截：${block.code} 生效中（先 reflect）`);
    lines.push(`工作区：${workspaceDir(config)}`);
    return clip(lines.join('\n'), MAX_RESULT);
  }

  function renderCheck(exec) {
    const hits = runDetectors();
    const state = ledgerState(sessionKeyOf(agentRef.current, exec), 8);
    const open = state.steps.filter(step => !['done', 'completed', 'complete', 'ok', 'passed', 'skipped'].includes(String(step.status).toLowerCase()));
    const lines = ['# EVOLVE 自检'];
    if (hits.length === 0) lines.push('检测器：未命中（没有重复失败、原地打转、未验证写入）。');
    for (const hit of hits) {
      lines.push(`- ${hit.code}：${hit.detail}`);
      lines.push(`  处置：停下当前路径 → 说出根因 → 换一个可验证的假设`);
    }
    if (open.length > 0) {
      lines.push(`未完成步骤：${open.map(step => `${step.id}.${clip(step.title, 30)}`).join(' / ')}`);
    }
    if (state.lastNoteAt) lines.push(`最近记账：${state.lastNoteAt}；超过 10 分钟没记账就先记一条。`);
    else if (state.hasPlan) lines.push('提示：计划已登记但一条 note 都没有，进度对用户不可见。');
    return clip(lines.join('\n'), MAX_RESULT);
  }

  function handlePlan(args, exec) {
    const raw = Array.isArray(args.steps) ? args.steps : [];
    const steps = raw
      .map((step, index) => {
        if (typeof step === 'string') return { id: String(index + 1), title: step.trim(), status: 'todo' };
        if (step && typeof step === 'object') {
          return {
            id: String(step.id ?? index + 1),
            title: String(step.title ?? step.text ?? step.step ?? `步骤 ${index + 1}`).trim(),
            status: String(step.status ?? 'todo'),
          };
        }
        return null;
      })
      .filter(step => step && step.title !== '');
    if (steps.length === 0 && typeof args.text === 'string' && args.text.trim() !== '') {
      steps.push({ id: '1', title: args.text.trim(), status: 'doing' });
    }
    if (steps.length === 0) return '计划为空：steps 传 ["侦察","实现","验证"] 这种数组，或 text 传一句话。';
    appendLedger(sessionKeyOf(agentRef.current, exec), { k: 'plan', steps });
    installSection();
    const next = steps.find(step => !['done', 'completed', 'ok'].includes(String(step.status).toLowerCase()));
    return clip(
      [`# 计划已登记（${steps.length} 步）`, ...steps.map((step, index) => `  ${index + 1}. ${step.title}`), next ? `下一步：${next.title}` : '全部完成，可以收尾。'].join('\n'),
      MAX_RESULT,
    );
  }

  function handleNote(args, exec) {
    const id = sessionKeyOf(agentRef.current, exec);
    const state = ledgerState(id, 8);
    const step = String(args.step ?? args.name ?? '').trim() || (state.steps.find(candidate => !['done', 'completed', 'complete', 'ok', 'passed', 'skipped'].includes(String(candidate.status).toLowerCase()))?.id ?? '');
    const status = String(args.status ?? (args.evidence ? 'done' : 'note')).trim();
    if (step === '') return 'note 需要 step（步骤 id 或标题）或先 evolve({action:"plan"}) 登记计划。';
    const entry = appendLedger(id, {
      k: 'note',
      step,
      status,
      evidence: clip(args.evidence ?? args.detail ?? '', 400),
    });
    strikes.clear();
    clearBlock('记账后清零');
    installSection();
    return clip(`已记账：步骤 ${step} → ${status}${entry.evidence ? `\n证据：${entry.evidence}` : '\n证据为空——记账要写可复核的东西（命令、路径、回执要点）。'}`, MAX_RESULT);
  }

  function handleReflect(args, exec) {
    const lesson = String(args.lesson ?? args.text ?? '').trim();
    if (lesson === '') return 'reflect 需要 lesson：写成「当 X 时做 Y，因为 Z」。';
    const targetScope = typeof args.scope === 'string' && args.scope.trim() !== '' ? args.scope.trim() : scope();
    const result = recordLesson(targetScope, lesson, { evidence: args.evidence ?? args.detail ?? '' });
    appendLedger(sessionKeyOf(agentRef.current, exec), {
      k: 'reflect',
      lesson: clip(lesson, 400),
      scope: targetScope,
      evidence: clip(args.evidence ?? args.detail ?? '', 400),
    });
    strikes.clear();
    clearBlock('reflect 后清零');
    lastCorrection = null;
    ruleSignature = '';
    installSection();
    return clip(
      [
        `# 教训已沉淀（规则库 v${result.version}）`,
        `规则：[${result.rule.id}] ${clip(result.rule.text, 200)}`,
        result.added ? '新规则：已加入，后续会话会自动注入。' : '同类规则已存在：已升版本并合并证据。',
        '拦截已解除，可以继续。',
      ].join('\n'),
      MAX_RESULT,
    );
  }

  function handleRules(args) {
    const op = String(args.op ?? 'list');
    if (op === 'revert') {
      const version = Number(args.version);
      if (!Number.isFinite(version)) return 'rules revert 需要 version（见 evolve({action:"rules"}) 输出里的版本号）。';
      const result = revertRules(scope(), version);
      ruleSignature = '';
      installSection();
      return `规则库已回滚到 v${result.from}（当前写入为 v${result.version}，恢复 ${result.restored} 条规则）。`;
    }
    if (op === 'mark') {
      const ruleId = String(args.ruleId ?? '').trim();
      if (ruleId === '') return 'rules mark 需要 ruleId。';
      const rule = markRuleOutcome(scope(), ruleId, String(args.outcome ?? 'used'));
      if (!rule) return `找不到规则 ${ruleId}。`;
      ruleSignature = '';
      return `已记录：${rule.id} 赢 ${rule.wins ?? 0}/用 ${rule.uses ?? 0}。`;
    }
    const store = loadRules(scope());
    const ranked = rankRules(store.rules ?? [], Math.max(config.maxRules, 12));
    if (ranked.length === 0) return `作用域 ${scope()} 还没有规则。修好问题后 evolve({action:"reflect", lesson:"..."}) 沉淀第一条。`;
    return clip(
      [
        `# 规则库 v${store.version ?? 0}（作用域 ${scope()}，注入前 ${config.maxRules} 条）`,
        ...ranked.map((rule, index) => `${index + 1}. [${rule.id}] ${clip(rule.text, 200)}（赢 ${rule.wins ?? 0}/用 ${rule.uses ?? 0}，v${rule.version ?? 1}）`),
        `回滚：evolve({action:"rules", op:"revert", version:<版本>})；标记有效：evolve({action:"rules", op:"mark", ruleId:"r..", outcome:"win"})`,
      ].join('\n'),
      MAX_RESULT,
    );
  }

  async function handlePlugin(args, exec) {
    if (!config.creationMode) return '创造模式已关闭：设置里打开 creationMode 后再用。';
    let creation;
    try {
      // install.mjs 是 creation.mjs 的宿主适配层：造/验/试跑之外，补上「装 + 回滚 + 体检」。
      creation = await import('./install.mjs');
    } catch (error) {
      return `创造模式模块加载失败：${describe(error)}`;
    }
    const cwd = resolveCwd(agentRef.current, exec);
    const base = { cwd, workspace: workspaceDir(config), config, logger: log, scope: scope(), ctx };
    const op = String(args.op ?? 'list');
    try {
      if (op === 'new') return clip(await creation.scaffold({ ...base, template: args.template, name: args.name, path: args.path, text: args.detail }), MAX_RESULT);
      if (op === 'validate') return clip(await creation.validateBundle({ ...base, path: args.path ?? args.name }), MAX_RESULT);
      if (op === 'test') return clip(await creation.smokeTest({ ...base, path: args.path ?? args.name }), MAX_RESULT);
      if (op === 'install') return clip(await creation.installBundle({ ...base, path: args.path ?? args.name, autoRollback: config.autoRollback }), MAX_RESULT);
      if (op === 'doctor') return clip(await creation.profileDoctor({ ...base, path: args.path ?? args.name }), MAX_RESULT);
      if (op === 'rollback') return clip(await creation.rollback({ ...base, path: args.path ?? args.name }), MAX_RESULT);
      if (op === 'list') return clip(await creation.listWorkspace(base), MAX_RESULT);
      return 'plugin 的 op 只接受 new | validate | test | install | doctor | rollback | list。';
    } catch (error) {
      return clip(`plugin ${op} 失败：${describe(error)}`, MAX_RESULT);
    }
  }

  async function handle(args, exec) {
    const action = String(args?.action ?? 'status');
    if (action === 'status') return renderStatus(exec);
    if (action === 'plan') return handlePlan(args ?? {}, exec);
    if (action === 'note' || action === 'phase') {
      if (action === 'phase') {
        const text = String(args.text ?? args.detail ?? '').trim();
        if (text === '') return 'phase 需要 text。';
        appendLedger(sessionKeyOf(agentRef.current, exec), { k: 'phase', text: clip(text, 200) });
        installSection();
        return `阶段已更新：${clip(text, 200)}`;
      }
      return handleNote(args ?? {}, exec);
    }
    if (action === 'check') return renderCheck(exec);
    if (action === 'reflect') return handleReflect(args ?? {}, exec);
    if (action === 'rules') return handleRules(args ?? {});
    if (action === 'plugin') return handlePlugin(args ?? {}, exec);
    if (action === 'override') {
      strikes.clear();
      clearBlock('override 逃生门');
      lastCorrection = null;
      appendLedger(sessionKeyOf(agentRef.current, exec), { k: 'override', detail: clip(args.detail ?? '', 300) });
      installSection();
      return '检测器计数已清零。注意：override 是逃生门，不是解决方案——下一次命中会更快升级。';
    }
    return 'action 只接受 status | plan | note | phase | check | reflect | rules | plugin | override。';
  }

  // ── 工具注册 ────────────────────────────────────────────────────────────
  const parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'plan', 'note', 'phase', 'check', 'reflect', 'rules', 'plugin', 'override'],
        description: 'status 看进度 / plan 登记计划 / note 记账 / check 自检 / reflect 沉淀教训 / rules 规则库 / plugin 创造模式 / override 清检测器',
      },
      steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } }, additionalProperties: true }, description: 'plan: 步骤列表' },
      text: { type: 'string', description: 'phase/detail 用的一句话' },
      step: { type: 'string', description: 'note: 步骤 id 或标题' },
      status: { type: 'string', description: 'note: done|failed|blocked|note' },
      evidence: { type: 'string', description: '可复核的证据：命令、路径、回执要点' },
      lesson: { type: 'string', description: 'reflect: 「当 X 时做 Y，因为 Z」' },
      scope: { type: 'string', description: 'reflect/rules: 作用域，默认按当前工作目录' },
      op: { type: 'string', description: 'rules: list|revert|mark；plugin: new|validate|test|install|doctor|rollback|list' },
      version: { type: 'number', description: 'rules revert 的目标版本' },
      ruleId: { type: 'string', description: 'rules mark 的规则 id' },
      outcome: { type: 'string', description: 'rules mark: win|used' },
      template: { type: 'string', description: 'plugin new 的模板：tool|preset|bundle' },
      name: { type: 'string', description: 'plugin 名字（也是插件目录名）' },
      path: { type: 'string', description: 'plugin 目标目录（绝对或相对工作区）' },
      detail: { type: 'string', description: '补充说明' },
    },
    required: ['action'],
  };

  const definition = {
    name: TOOL_NAME,
    description:
      '进化 PTC 的进程工具：登记计划/记账（plan/note）、随时自检（check）、把教训沉淀成规则（reflect/rules）、用创造模式检查并安装插件（plugin）。每步的系统提示会自动出现 [EVOLVE 进程] 段，命中重复失败/原地打转/未验证写入时会注入纠错块。',
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try {
        return await handle(args ?? {}, exec);
      } catch (error) {
        return `evolve 失败：${describe(error)}`;
      }
    },
  };

  try {
    let defineTool = null;
    try {
      const resolver = createResolver(ctx);
      const entry = resolver.resolve('@deepseek-ai/dsh-tools');
      if (entry) {
        const module = await import(pathToFileURL(entry).href);
        defineTool = module.defineTool ?? module.default?.defineTool ?? null;
      }
    } catch {
      defineTool = null;
    }
    const tool = typeof defineTool === 'function' ? defineTool(definition) : definition;
    toolDispose = ctx.tools.register(tool, {
      when: context => {
        if (context?.agent) agentRef.current = context.agent;
        return true;
      },
    });
  } catch (error) {
    log.error?.(`[evolve-ptc] 注册 ${TOOL_NAME} 工具失败：${describe(error)}`);
  }

  // ── 每步刷新 + 检测 ─────────────────────────────────────────────────────
  const preStep = async (payload, next) => {
    if (payload?.agent) agentRef.current = payload.agent;
    let decision;
    decision = await next();
    void decision;
    try {
      if (payload?.agent) {
        refreshRules();
        // 拦截有出口：到点自动解除，不依赖模型记得去 reflect。
        if (block.active && Date.now() - block.since > BLOCK_MS) clearBlock(`已过 ${BLOCK_MS / 1000}s`);
        installSection();
        if (config.correctiveBlocks) runDetectors();
      }
    } catch (error) {
      log.warn?.(`[evolve-ptc] 每步刷新失败：${describe(error)}`);
    }
    return decision;
  };

  try {
    ctx.on('agent/pre-step', preStep);
  } catch (error) {
    log.warn?.(`[evolve-ptc] 挂载 agent/pre-step 失败：${describe(error)}`);
  }

  // ── 硬拦截（只拦写操作；读操作永远放行）────────────────────────────────
  if (typeof ctx.tools?.guard === 'function') {
    try {
      ctx.tools.guard((...guardArgs) => {
        if (!block.active) return undefined;
        let toolName = '';
        for (const value of guardArgs) {
          if (!value || typeof value !== 'object') continue;
          const candidate = value.name ?? value.tool?.name ?? value.call?.name ?? value.definition?.name;
          if (typeof candidate === 'string') {
            toolName = candidate;
            break;
          }
        }
        if (toolName === '' || toolName === TOOL_NAME) return undefined;
        // 只拦会改变外部状态的工具：诊断用的读/截图/搜索必须一直可用，
        // 否则模型被锁在原地又无法收集证据，只能干等超时（v0.1.0 的第二次事故）。
        if (!WRITE_TOOLS.has(toolName)) return undefined;
        return `[EVOLVE 硬拦截] ${toolName} 属于写操作，检测器 ${block.code} 连续命中 ${block.hits} 次。先调用 evolve({action:"reflect", lesson:"当 X 时做 Y，因为 Z"}) 写下根因与下一步；读操作与 evolve 不受限制，${Math.round(BLOCK_MS / 1000)} 秒后也会自动解除。`;
      });
    } catch (error) {
      log.warn?.(`[evolve-ptc] 硬拦截降级为提示（tools.guard 签名不匹配）：${describe(error)}`);
    }
  }

  // ── 命令：/evolve-status ────────────────────────────────────────────────
  // commands 是可选服务：预设行可能比它更早挂载，取不到就跳过，绝不因为一条命令让整行失败。
  const commands = (() => {
    try {
      return ctx.get?.('commands');
    } catch {
      return undefined;
    }
  })();
  if (commands?.register) {
    try {
      commands.register({
        name: 'evolve-status',
        description: '查看进化 PTC 的账本、规则库与检测器状态',
        handler: ({ agent }) => {
          if (agent) agentRef.current = agent;
          return { kind: 'success', text: renderStatus(null) };
        },
      });
    } catch (error) {
      log.warn?.(`[evolve-ptc] 注册 /evolve-status 失败：${describe(error)}`);
    }
  }

  // ── 监听工具结果，作为会话事件不可用时的活动来源 ──────────────────────
  const onToolResult = payload => {
    try {
      const toolName = payload?.name ?? payload?.call?.name ?? payload?.tool?.name ?? payload?.definition?.name ?? '';
      if (typeof toolName !== 'string' || toolName === '') return;
      activityFromListener.push({ name: toolName, ok: !looksLikeFailure(payload?.result ?? payload), at: Date.now() });
      if (activityFromListener.length > ACTIVITY_LIMIT) activityFromListener.shift();
    } catch {
      // 观测失败不影响主流程。
    }
  };
  for (const eventName of ['tool/result', 'tools/result']) {
    try {
      ctx.on(eventName, onToolResult);
    } catch {
      // 事件不存在就算了。
    }
  }

  installSection();

  ctx.effect(() => () => {
    try {
      sectionDispose?.();
    } catch {
      // 已回收。
    }
    try {
      toolDispose?.();
    } catch {
      // 已回收。
    }
  });

  ctx.effect(() => () => {
    try {
      if (lastCorrection) appendLedger(sessionKeyOf(agentRef.current, null), { k: 'shutdown', at: nowIso() });
    } catch {
      // 收尾失败无所谓。
    }
  });
}

/** 给 doctor 用：本插件在 profile 里的落点。 */
export function profileRoot() {
  const configured = process.env.DSH_PROFILE_DIR;
  if (configured && configured.trim() !== '') return configured.trim();
  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE ?? 'desktop';
  return join(home && home.trim() !== '' ? home.trim() : evolveRoot(), '..', 'profiles', profile);
}

export function readProfileFile(relative) {
  const file = join(profileRoot(), relative);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
