/**
 * 运行时冒烟：在**桩 ctx** 里真跑一遍 `lib/runtime.mjs` 的 apply，验证「工具注册 → 计划/状态 →
 * 每步注入 → 检测器命中 → 硬拦截 → 规则沉淀」这条主链路。
 *
 * 这不是 mock 被测代码：runtime.mjs 原样 import，账本/规则真的落在临时 EVOLVE_ROOT 里。
 * 只在「宿主上下文」这一层做桩：tools / systemPrompt / on / effect / commands。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const describe = error => (error instanceof Error ? error.message : String(error));

function createStubContext() {
  const state = { tools: [], guards: [], sections: [], listeners: new Map(), commands: [], disposers: [] };
  const commandsService = {
    register(command) {
      state.commands.push(command);
      return () => {};
    },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition, options) {
        state.tools.push({ definition, options });
        return () => {};
      },
      guard(fn) {
        state.guards.push(fn);
        return () => {};
      },
    },
    systemPrompt: {
      section(segment) {
        state.sections.push(segment);
        return () => {
          const index = state.sections.indexOf(segment);
          if (index >= 0) state.sections.splice(index, 1);
        };
      },
    },
    on(name, fn) {
      if (!state.listeners.has(name)) state.listeners.set(name, []);
      state.listeners.get(name).push(fn);
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') state.disposers.push(disposer);
      return () => {};
    },
    commands: commandsService,
    get(name) {
      // 真实宿主里可选服务走 ctx.get 取；桩里把 commands 暴露给这条路径。
      return name === 'commands' ? commandsService : undefined;
    },
  };
  return { ctx, state };
}

/** 造一个「会话里刚连续失败三次同一工具」的 agent 桩。 */
function failingAgent(cwd) {
  const events = [];
  for (let index = 1; index <= 3; index += 1) {
    events.push({ type: 'tool/call', data: { callId: `c${index}`, name: 'computer_click', args: { x: 1, y: 2 } } });
    events.push({ type: 'tool/result', data: { callId: `c${index}`, error: { message: 'timeout' } } });
  }
  return { cwd, session: { id: 'sess-runtime-smoke', events } };
}

export async function runRuntimeSmoke() {
  const failures = [];
  const notes = [];
  const fail = (message, fix) => failures.push({ message, fix });
  const previousRoot = process.env.EVOLVE_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'evolve-runtime-'));
  process.env.EVOLVE_ROOT = root;
  try {
    const { apply } = await import('../lib/runtime.mjs');
    const { ctx, state } = createStubContext();
    await apply(ctx, { processInjection: true, rulesInjection: true, creationMode: false, hardBlockAfter: 3 });

    // ① 工具注册
    const tool = state.tools.find(entry => entry.definition?.name === 'evolve')?.definition;
    if (!tool) {
      fail('运行时没有注册 evolve 工具', '检查 runtime.mjs 的 ctx.tools.register 分支与 defineTool 解析');
      return { failures, notes, root };
    }
    const exec = { signal: undefined, agent: null };
    const run = args => tool.execute(args, exec);
    if (!tool.output?.schema || typeof tool.output?.render !== 'function') fail('evolve 工具缺 output.schema/render', '按 dsh-tools 契约补');

    // ② 计划 / 状态 / 记账
    const planned = await run({ action: 'plan', steps: [{ id: '1', title: '观察桌面', status: 'todo' }, { id: '2', title: '点一下按钮' }] });
    if (!String(planned).includes('计划')) fail(`plan 没回计划：${planned}`, '检查 handlePlan 与账本写入');
    else notes.push('plan ok');
    const status = await run({ action: 'status' });
    if (!String(status).includes('EVOLVE 状态')) fail(`status 输出异常：${status}`, '检查 renderStatus');
    else notes.push('status ok');
    const noted = await run({ action: 'note', step: '1', status: 'done', evidence: '截图已回读' });
    if (!String(noted).includes('1')) fail(`note 没记账：${noted}`, '检查 handleNote');

    // ③ 每步注入
    const agent = failingAgent(root);
    const preStep = state.listeners.get('agent/pre-step')?.[0];
    if (!preStep) fail('没有挂 agent/pre-step 监听器', '检查 runtime.mjs 末尾的 ctx.on');
    else {
      const decision = await preStep({ agent, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
      if (!decision || decision.kind !== 'enter') fail('pre-step 没有把宿主的决策透传回去', '必须 return await next() 的结果');
      const segment = state.sections.find(entry => entry.name === 'evolve-ptc:process');
      const text = typeof segment?.text === 'function' ? segment.text() : segment?.text ?? '';
      if (!String(text).includes('[EVOLVE 进程]')) fail(`注入段没有标记：${String(text).slice(0, 120)}`, '检查 buildSectionText');
      else notes.push('注入段 ok');
      if (!String(text).includes('计划')) fail('注入段里看不到计划进度', '检查 renderPlan');
    }

    // ④ 检测器 + 硬拦截（升级要连续命中 hardBlockAfter 次，真实场景每步一次 → 连跑 3 步）
    if (preStep) {
      for (let step = 2; step <= 3; step += 1) {
        await preStep({ agent, messages: [], turn: 1, step }, async () => ({ kind: 'enter', messages: [] }));
      }
      const segments = state.sections.filter(entry => entry.name === 'evolve-ptc:process');
      if (segments.length > 1) fail(`注入段被重复注册 ${segments.length} 次（会重复吃 token）`, 'installSection 里先 dispose 旧段');
    }
    const guard = state.guards[0];
    if (!guard) fail('没有注册 tools.guard（硬拦截通道）', '检查 runtime.mjs 的 ctx.tools.guard 分支');
    else {
      let blocked = '';
      for (const probe of [
        { name: 'computer_click', args: {} },
        { tool: { name: 'computer_click' } },
        { call: { name: 'computer_click' } },
        { definition: { name: 'computer_click' } },
      ]) {
        const verdict = guard(probe);
        if (typeof verdict === 'string' && verdict.includes('evolve')) {
          blocked = verdict;
          break;
        }
      }
      if (blocked === '') fail('连续失败三次后 guard 没有拦截非 evolve 工具', '检查 runDetectors 的 block.active 与 guard 的参数解析');
      else notes.push('硬拦截 ok');
      const evolveCall = guard({ name: 'evolve' });
      if (typeof evolveCall === 'string') fail('guard 把 evolve 自己也拦了（会死锁）', 'guard 里必须放行 evolve');
    }

    // ⑤ 规则沉淀
    const reflected = await run({ action: 'reflect', lesson: '当截图确认点击生效时再继续下一步，因为回读是唯一可信证据' });
    if (!String(reflected).includes('规则')) fail(`reflect 没写规则：${reflected}`, '检查 handleReflect 与 recordLesson');
    else notes.push('reflect ok');
    const listed = await run({ action: 'rules', op: 'list' });
    if (!String(listed).includes('当截图确认点击生效')) fail('规则库里查不到刚沉淀的规则', '检查 rankRules/loadRules 作用域');

    // ⑥ 创造模式开关
    const closed = await run({ action: 'plugin', op: 'list' });
    if (!String(closed).includes('创造模式已关闭')) fail(`creationMode:false 时 plugin 没被挡住：${closed}`, '检查 handlePlugin 的开关判断');
    else notes.push('创造模式开关 ok');

    // ⑦ 命令
    if (!state.commands.some(command => command.name === 'evolve-status')) fail('没有注册 /evolve-status 命令', '检查 ctx.commands.register');
  } catch (error) {
    failures.push({ message: `运行时冒烟抛异常：${describe(error)}`, fix: '从上面的堆栈定位 runtime.mjs' });
  } finally {
    process.env.EVOLVE_ROOT = previousRoot;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
  return { failures, notes };
}
