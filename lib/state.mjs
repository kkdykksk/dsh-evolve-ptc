/**
 * 状态层：任务账本（JSONL）+ 规则库（JSON，带版本与快照）+ 检测器（纯函数）。
 *
 * 三者的关系：检测器读账本与近期工具活动 → 命中就注入纠错块 → 模型按纠错块行动并
 * `reflect` 写教训 → 教训进规则库 → 规则在下个会话被注入。整条链路的每一跳都落在
 * `$DSH_HOME/evolve/` 下，可读、可 diff、可回滚。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { evolveRoot, ensureDir, ledgerFile, rulesFile } from './paths.mjs';

export const nowIso = () => new Date().toISOString();

const LEDGER_MAX_BYTES = 512 * 1024;
const LEDGER_KEEP_LINES = 400;
const RULE_HISTORY_LIMIT = 12;
const RULE_SNAPSHOT_LIMIT = 8;

// ─────────────────────────────── 任务账本 ───────────────────────────────

function trimLedger(file) {
  try {
    if (!existsSync(file) || statSync(file).size <= LEDGER_MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, `${lines.slice(-LEDGER_KEEP_LINES).join('\n')}\n`, 'utf8');
  } catch {
    // 裁剪失败不影响追加。
  }
}

/** 追加一条账本记录；返回落盘后的记录。 */
export function appendLedger(sessionId, entry) {
  const file = ledgerFile(sessionId);
  ensureDir(join(evolveRoot(), 'ledgers'));
  const record = { t: nowIso(), ...entry };
  trimLedger(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/** 读账本（尾部 limit 条）。损坏行被跳过，不抛异常。 */
export function readLedger(sessionId, limit = 200) {
  const file = ledgerFile(sessionId);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '');
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const entries = [];
    for (const line of slice) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch {
        // 半行（进程被杀）跳过即可。
      }
    }
    return entries;
  } catch {
    return [];
  }
}

const STATUS_DONE = new Set(['done', 'completed', 'complete', 'ok', 'passed', 'skipped']);

/** 把账本折算成一份可注入的、极简的当前状态。 */
export function ledgerState(sessionId, maxSteps = 8) {
  const entries = readLedger(sessionId, 400);
  let plan = null;
  let phase = '';
  let lastNoteAt = null;
  let lastEntryAt = null;
  const notes = new Map();
  const signals = [];
  const lessons = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    lastEntryAt = entry.t ?? lastEntryAt;
    if (entry.k === 'plan' && Array.isArray(entry.steps)) plan = entry;
    else if (entry.k === 'note') {
      notes.set(String(entry.step ?? entry.title ?? '?'), entry);
      lastNoteAt = entry.t ?? lastNoteAt;
    } else if (entry.k === 'phase') phase = String(entry.text ?? '');
    else if (entry.k === 'signal') signals.push(entry);
    else if (entry.k === 'reflect' && entry.lesson) lessons.push(String(entry.lesson));
  }
  const steps = [];
  if (plan) {
    for (const raw of plan.steps.slice(0, maxSteps)) {
      const id = String(raw?.id ?? raw?.step ?? steps.length + 1);
      const title = String(raw?.title ?? raw?.text ?? raw?.step ?? `步骤 ${id}`);
      const note = notes.get(id);
      const status = note ? String(note.status ?? 'note') : raw?.status ? String(raw.status) : 'todo';
      steps.push({ id, title, status, evidence: note?.evidence ? String(note.evidence).slice(0, 160) : '' });
    }
  }
  const done = steps.filter(step => STATUS_DONE.has(step.status.toLowerCase())).length;
  return {
    entries,
    plan,
    steps,
    done,
    total: steps.length,
    phase,
    lastNoteAt,
    lastEntryAt,
    lessons: lessons.slice(-4),
    lastSignal: signals.length > 0 ? signals[signals.length - 1] : null,
    hasPlan: Boolean(plan),
  };
}

/** 清理过期账本（按天）。返回删除数量。 */
export function pruneLedgers(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const directory = join(evolveRoot(), 'ledgers');
  if (!existsSync(directory)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(directory, name);
      try {
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed += 1;
        }
      } catch {
        // 单个文件失败继续。
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

// ─────────────────────────────── 规则库 ───────────────────────────────

/** 把工作目录变成一个稳定的作用域键（同一项目共享规则，不同项目隔离）。 */
export function scopeForCwd(cwd) {
  const raw = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : 'global';
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  // FNV-1a：不依赖 crypto，结果稳定且短，够当一个目录键。
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p-${hash.toString(16).padStart(8, '0')}`;
}

const emptyStore = scope => ({
  version: 0,
  scope,
  updatedAt: nowIso(),
  rules: [],
  history: [],
  snapshots: [],
});

export function loadRules(scope) {
  const file = rulesFile(scope);
  if (!existsSync(file)) return emptyStore(scope);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore(scope);
    return {
      version: Number.isFinite(parsed.version) ? parsed.version : 0,
      scope: parsed.scope ?? scope,
      updatedAt: parsed.updatedAt ?? nowIso(),
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter(rule => rule && typeof rule.text === 'string') : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    };
  } catch {
    return emptyStore(scope);
  }
}

function saveRules(store) {
  ensureDir(join(evolveRoot(), 'rules'));
  const file = rulesFile(store.scope);
  const next = { ...store, updatedAt: nowIso(), version: (store.version ?? 0) + 1 };
  next.snapshots = [...(store.snapshots ?? []), { version: next.version, at: next.updatedAt, rules: store.rules }].slice(
    -RULE_SNAPSHOT_LIMIT,
  );
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return next;
}

const normalizeText = text => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

let ruleSequence = 0;
const newRuleId = () => `r${Date.now().toString(36)}${(ruleSequence += 1).toString(36)}`;

/**
 * 沉淀一条规则。同一 scope 下文本重复的规则不新增，只升版本并合并证据。
 * @returns {version, rule, added} 版本号用于回滚。
 */
export function recordLesson(scope, lesson, options = {}) {
  const text = String(lesson ?? '').trim();
  if (text === '') throw new Error('lesson 不能为空：写清「当 X 时做 Y，因为 Z」');
  const store = loadRules(scope);
  const signature = normalizeText(text);
  const existing = store.rules.find(rule => normalizeText(rule.text) === signature);
  const at = nowIso();
  if (existing) {
    existing.version = (existing.version ?? 1) + 1;
    existing.uses = (existing.uses ?? 0) + (options.uses ? 1 : 0);
    existing.wins = (existing.wins ?? 0) + (options.win ? 1 : 0);
    existing.updatedAt = at;
    if (options.evidence) existing.evidence = String(options.evidence).slice(0, 400);
    existing.status = 'active';
    store.history = [...store.history, { at, action: 'bump', ruleId: existing.id, version: existing.version }].slice(
      -RULE_HISTORY_LIMIT,
    );
    const saved = saveRules(store);
    return { version: saved.version, rule: existing, added: false };
  }
  const rule = {
    id: newRuleId(),
    text: text.slice(0, 400),
    scope,
    evidence: String(options.evidence ?? '').slice(0, 400),
    createdAt: at,
    updatedAt: at,
    uses: 0,
    wins: options.win ? 1 : 0,
    version: 1,
    status: 'active',
  };
  store.rules = [...store.rules, rule].slice(-80);
  store.history = [...store.history, { at, action: 'add', ruleId: rule.id, version: 1 }].slice(-RULE_HISTORY_LIMIT);
  const saved = saveRules(store);
  return { version: saved.version, rule, added: true };
}

/** 记录一次「这条规则派上了用场 / 真的赢了一次」。 */
export function markRuleOutcome(scope, ruleId, outcome) {
  const store = loadRules(scope);
  const rule = store.rules.find(candidate => candidate.id === ruleId);
  if (!rule) return null;
  if (outcome === 'win') rule.wins = (rule.wins ?? 0) + 1;
  rule.uses = (rule.uses ?? 0) + 1;
  rule.updatedAt = nowIso();
  saveRules(store);
  return rule;
}

/** 规则排序：赢过的优先，被引用得多降权，最近更新的微加权。 */
export function rankRules(rules, max) {
  const now = Date.now();
  const scored = rules
    .filter(rule => rule && rule.status !== 'archived' && typeof rule.text === 'string' && rule.text.trim() !== '')
    .map(rule => {
      const wins = Number(rule.wins ?? 0);
      const uses = Number(rule.uses ?? 0);
      const ageDays = Math.max(0, (now - Date.parse(rule.updatedAt ?? rule.createdAt ?? nowIso())) / 86400000);
      const score = 1 + wins * 2 - uses * 0.12 - Math.min(1.5, ageDays / 30);
      return { rule, score };
    })
    .sort((left, right) => right.score - left.score || String(left.rule.id).localeCompare(String(right.rule.id)));
  return scored.slice(0, max).map(entry => entry.rule);
}

/** 回滚到某个版本（用该版本保存的快照恢复规则集）。 */
export function revertRules(scope, version) {
  const store = loadRules(scope);
  const target = Number(version);
  const snapshot = [...(store.snapshots ?? [])].reverse().find(entry => Number(entry.version) === target);
  if (!snapshot) {
    throw new Error(`找不到版本 ${version} 的规则快照；可用版本：${(store.snapshots ?? []).map(entry => entry.version).join(', ') || '无'}`);
  }
  const restored = {
    ...store,
    rules: snapshot.rules,
    history: [...store.history, { at: nowIso(), action: 'revert', version: target }].slice(-RULE_HISTORY_LIMIT),
  };
  const saved = saveRules({ ...restored, version: store.version });
  return { version: saved.version, restored: snapshot.rules.length, from: target };
}

// ─────────────────────────────── 检测器 ───────────────────────────────

export const WRITE_TOOLS = new Set([
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_paste',
  'computer_drag',
  'computer_scroll',
  'computer_actions',
  'computer_launch',
  'computer_stop',
  'browser_actions',
  'write',
  'edit',
]);

const OBSERVE_TOOLS = new Set([
  'computer_screenshot',
  'computer_ui',
  'computer_windows',
  'computer_clipboard',
  'browser_state',
  'read',
  'read_image',
  'ops_inspect_local_file',
  'ops_grep',
  'ops_glob',
]);

const signatureOf = call => {
  if (!call) return '';
  const args = call.args ?? call.input;
  let payload = '';
  try {
    payload = args === undefined ? '' : JSON.stringify(args).slice(0, 200);
  } catch {
    payload = '';
  }
  return `${call.name ?? '?'}${payload}`;
};

/**
 * 纯函数检测器。全部输入都是普通数据，便于单测。
 * @param activity 近期工具调用（时间升序）：{name, ok, args, at}
 * @returns {code, detail}[]，最多 2 条（避免一次塞太多）。
 */
export function detect({ activity, softFailures = 0, config = {} }) {
  const hits = [];
  const score = {
    repeatFailure: Math.max(2, Number(config.hardBlockAfter ?? 3)),
    spin: 3,
    unverifiedWrite: 4,
  };
  const recent = Array.isArray(activity) ? activity.slice(-14) : [];

  // 1. 重复失败：同一工具连续失败达到阈值。
  const failures = recent.filter(call => call && call.ok === false);
  if (failures.length >= score.repeatFailure) {
    const byName = new Map();
    for (const call of failures) {
      const name = String(call.name ?? '?');
      byName.set(name, [...(byName.get(name) ?? []), call]);
    }
    for (const [name, list] of byName) {
      if (list.length >= score.repeatFailure) {
        hits.push({
          code: 'repeatFailure',
          detail: `${name} 最近连续失败 ${list.length} 次：${String(list[list.length - 1]?.error ?? '原因未知').slice(0, 180)}`,
        });
        break;
      }
    }
  }

  // 2. 原地打转：最近 10 次里同一个签名重复出现。
  const window = recent.slice(-10);
  const counts = new Map();
  for (const call of window) {
    const signature = signatureOf(call);
    if (signature === '') continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  for (const [signature, count] of counts) {
    if (count >= score.spin && signature.split('{')[0] === signature) {
      hits.push({ code: 'spin', detail: `同一个调用 ${signature} 在最近 ${window.length} 次里重复了 ${count} 次，画面/状态没有变化` });
      break;
    }
  }

  // 3. 未验证写入：写入之后没有回读就继续写入。
  let dirty = null;
  for (const call of recent) {
    const name = String(call?.name ?? '');
    if (OBSERVE_TOOLS.has(name)) {
      dirty = null;
      continue;
    }
    if (!WRITE_TOOLS.has(name)) continue;
    if (dirty) {
      hits.push({
        code: 'unverifiedWrite',
        detail: `写入 ${dirty} 之后没有回读验证，就继续写入 ${name}；动作失效时你无法区分「没生效」和「生效了但视图没刷新」`,
      });
      break;
    }
    dirty = name;
  }

  // 4. 软失败堆积：工具结果不是硬错误但一直在降级（例如超时、空结果）。
  if (softFailures >= 3) {
    hits.push({ code: 'softFailures', detail: `连续 ${softFailures} 次工具结果降级（超时/空/部分失败），换一条通道或换一个假设` });
  }

  return hits.slice(0, 2);
}
