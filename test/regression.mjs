/**
 * 回归测试：v0.1.4 修复项的针对性验证。
 *
 * 覆盖：
 *   - correctiveBlocks 开关（含 check 路径不许升级拦截）
 *   - 会话隔离（会话 A 的硬拦截不锁死会话 B）
 *   - 检测器误判（无参观察工具、失败的写操作）
 *   - 脏时间戳排序不崩
 *   - 包名解析的越界校验
 *
 * 由 scripts/check.mjs 调用；也可直接 `node test/regression.mjs`。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

process.env.EVOLVE_ROOT = join(tmpdir(), `evolve-regression-${process.pid}`);
process.env.EVOLVE_PTC_ALLOW_RAW_DEFINE = '1';

// 相对本文件推导，避免硬编码盘符（下面用 import.meta.url 覆盖）。
const { fileURLToPath } = await import('node:url');
const here = fileURLToPath(new URL('.', import.meta.url));
const libUrl = new URL('../lib/', import.meta.url).href;

const { detect, rankRules } = await import(`${libUrl}state.mjs`);
const { apply } = await import(`${libUrl}runtime.mjs`);
const { validateBundle } = await import(`${libUrl}creation.mjs`);

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) { pass += 1; console.log(`  ✔ ${message}`); }
  else { fail += 1; console.log(`  ✘ ${message}`); }
};

function setupCtx() {
  const handlers = {};
  let guardFn = null;
  const tools = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(tool) { tools.push(tool); return () => {}; },
      guard(fn) { guardFn = fn; return () => {}; },
      on(name, fn) { handlers[name] = fn; return () => {}; },
    },
    systemPrompt: { section() { return () => {}; } },
    on(name, fn) { handlers[name] = fn; return () => {}; },
    effect(fn) { try { fn(() => {}); } catch { /* 已回收 */ } },
    get() { return undefined; },
  };
  return { ctx, handlers, guard: () => guardFn, tools };
}

// 每次 snapshotEvents 生成时间戳递增的失败事件，模拟真实的新失败批次。
function failingAgent(id) {
  let tick = 0;
  return {
    id,
    session: {
      id,
      snapshotEvents() {
        tick += 1;
        const base = Date.now() + tick * 1000;
        const events = [];
        for (let i = 0; i < 5; i += 1) {
          const callId = `${id}_${tick}_c${i}`;
          events.push({ type: 'tool/call', at: base + i, data: { callId, name: 'computer_click', arguments: { x: i } } });
          events.push({ type: 'tool/result', at: base + i, data: { callId, error: 'boom' } });
        }
        return events;
      },
    },
  };
}

console.log('[回归] 检测器误判');
ok(detect({ activity: [
  { name: 'computer_screenshot', ok: true },
  { name: 'computer_screenshot', ok: true },
  { name: 'computer_screenshot', ok: true },
] }).filter(hit => hit.code === 'spin').length === 0, '无参截图连续 3 次不误判 spin');
ok(detect({ activity: [
  { name: 'computer_click', ok: false },
  { name: 'computer_click', ok: false },
] }).filter(hit => hit.code === 'unverifiedWrite').length === 0, '失败的写操作不误报 unverifiedWrite');
ok(Array.isArray(rankRules([{ id: 'a', text: 'x', updatedAt: 'bad-date', status: 'active' }], 5)), '脏时间戳规则排序不崩');

console.log('[回归] 硬拦截开关与会话隔离');
{
  const { ctx, handlers, guard } = setupCtx();
  await apply(ctx, { correctiveBlocks: true, hardBlockAfter: 2 });
  const agent = failingAgent('A');
  for (let i = 0; i < 3; i += 1) await handlers['agent/pre-step']({ agent }, async () => ({}));
  ok(Boolean(guard()({ name: 'computer_click', agent })), 'correctiveBlocks=true 时连续失败触发拦截');
}
{
  const { ctx, handlers, guard } = setupCtx();
  await apply(ctx, { correctiveBlocks: false, hardBlockAfter: 2 });
  const agent = failingAgent('B');
  for (let i = 0; i < 3; i += 1) await handlers['agent/pre-step']({ agent }, async () => ({}));
  ok(!guard()({ name: 'computer_click', agent }), 'correctiveBlocks=false 时 preStep 不升级拦截');
}
{
  const { ctx, handlers, guard } = setupCtx();
  await apply(ctx, { correctiveBlocks: true, hardBlockAfter: 2 });
  const agentA = failingAgent('C');
  const agentB = failingAgent('D');
  for (let i = 0; i < 3; i += 1) await handlers['agent/pre-step']({ agent: agentA }, async () => ({}));
  ok(Boolean(guard()({ name: 'computer_click', agent: agentA })) && !guard()({ name: 'computer_click', agent: agentB }), '会话隔离：A 被拦截而 B 放行');
}

console.log('[回归] 包名解析越界校验');
{
  const dir = join(tmpdir(), `evolve-regression-evil-${process.pid}`);
  try {
    mkdirSync(join(dir, 'evil'), { recursive: true });
    writeFileSync(join(dir, 'evil', 'package.json'), JSON.stringify({
      name: 'evil', type: 'module', main: '../../outside.js', dsh: { bundle: { patch: './c.yml' } },
    }));
    writeFileSync(join(dir, 'evil', 'c.yml'), '- insert: []\n');
    const result = validateBundle(join(dir, 'evil'));
    ok(!result.ok && result.errors.some(item => String(item).includes('包外')), 'main 指向包外被拒绝');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

try { rmSync(process.env.EVOLVE_ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n回归结果：${pass} 通过 / ${fail} 失败`);
if (typeof process.env.EVOLVE_REGRESSION_ONLY === 'string') process.exit(fail ? 1 : 0);
export const regressionResult = { pass, fail };
