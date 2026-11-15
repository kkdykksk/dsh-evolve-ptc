/**
 * 创造模式的「装」这一半：把 `lib/creation.mjs`（只会造/验/试跑）接到宿主上。
 *
 * 为什么要这一层：
 * - creation.mjs 是纯函数式工具（`scaffold({root,name,template})`、`validateBundle(dir)`…），
 *   不碰宿主；而 `evolve` 工具传进来的是 `{cwd, workspace, config, ctx, path, name, template}`。
 * - 安装与回滚必须动 profile（`package.json` + `dsh.profile.bundles`），这只有宿主的
 *   `pluginManager` 服务能做。服务拿不到时**不假装成功**，而是退回「快照 + 让模型调
 *   plugin_manager 工具 + 事后 doctor 校验」，并在结果里写清楚为什么。
 *
 * 所有导出都是「对象参数」形态，与 runtime.mjs 的调用一一对应。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { dshHome, profileSnapshotDir } from './paths.mjs';

const clip = (value, limit) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};
const describe = error => (error instanceof Error ? error.message : String(error));
const lines = parts => parts.filter(part => part !== '' && part !== null && part !== undefined).join('\n');

/** profile 目录：环境变量优先（宿主注入），否则按 DSH_HOME 推。 */
export function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const name = process.env.DSH_PROFILE || 'desktop';
  return resolve(dshHome(), 'profiles', name);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `path` / `name` 两种写法都接受：给了 path 就用它（绝对或相对工作区），否则 workspace/name。 */
function targetDir({ path, name, workspace, cwd }) {
  const pathText = String(path ?? '').trim();
  if (pathText !== '') return isAbsolute(pathText) ? resolve(pathText) : resolve(workspace ?? cwd ?? process.cwd(), pathText);
  const nameText = String(name ?? '').trim();
  if (nameText === '') return '';
  return resolve(workspace ?? cwd ?? process.cwd(), nameText);
}

/** 让 creation 的 `root + name` 形态与 targetDir 对齐。 */
function splitTarget(dir) {
  return { root: dirname(dir), name: basename(dir) };
}

async function creation() {
  return import('./creation.mjs');
}

const output = (value, limit = 3800) => clip(value, limit);

// ── new ────────────────────────────────────────────────────────────────────
export async function scaffold({ path, name, template, text, workspace, cwd, logger }) {
  const creationModule = await creation();
  const templateName = String(template ?? 'tool').trim() || 'tool';
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir === '') return 'plugin new 需要 name 或 path（name 是插件目录名）。';
  const { root, name: leaf } = splitTarget(dir);
  const overwrite = /\boverwrite\b/i.test(String(text ?? ''));
  const result = creationModule.scaffold({ root, name: leaf, template: templateName, overwrite });
  if (!result?.ok) {
    return output(lines([`❌ plugin new 失败（模板 ${templateName}，目标 ${dir}）`, ...(result?.errors ?? ['未知错误'])].join('\n')));
  }
  logger?.info?.(`[evolve-ptc] scaffold ${dir} (${templateName})`);
  return output(
    lines([
      `✅ plugin new：${dir}`,
      `模板 ${templateName}，写入 ${result.created.length} 个文件：${result.created.join(', ')}`,
      ...(result.warnings?.length ? [`warnings：${result.warnings.join('；')}`] : []),
      '',
      '下一步固定顺序：plugin validate → plugin test → plugin install（install 前会自动快照 profile）。',
    ]),
  );
}

// ── validate ───────────────────────────────────────────────────────────────
export async function validateBundle({ path, name, workspace, cwd }) {
  const creationModule = await creation();
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir === '') return 'plugin validate 需要 path 或 name。';
  const result = creationModule.validateBundle(dir);
  const head = result.ok
    ? `✅ validate ${dir}`
    : `❌ validate ${dir}：${result.errors.length} 项错误`;
  const manifest = result.manifest ?? {};
  return output(
    lines([
      head,
      `name=${manifest.name ?? '?'} preset=${manifest.hasPreset ? manifest.presetIds.join('|') : '无'} client=${manifest.hasClient ? 'yes' : 'no'} patch=${manifest.patchPath ?? '无'}`,
      ...(result.errors?.length ? ['错误：', ...result.errors.map(item => `  - ${item}`)] : []),
      ...(result.warnings?.length ? ['警告：', ...result.warnings.map(item => `  - ${item}`)] : []),
      result.ok ? '下一步：plugin test（在沙箱里真跑一次 apply，看工具能不能注册）。' : '先按上面的错误改文件，再 validate。',
    ]),
  );
}

// ── test ───────────────────────────────────────────────────────────────────
export async function smokeTest({ path, name, workspace, cwd }) {
  const creationModule = await creation();
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir === '') return 'plugin test 需要 path 或 name。';
  const result = creationModule.smokeTest(dir, { timeoutMs: 20000 });
  const tools = (result.tools ?? []).map(tool => String(tool?.name ?? '?'));
  return output(
    lines([
      result.ok ? `✅ test ${dir}` : `❌ test ${dir}`,
      `entry=${result.entry ?? '?'} name=${result.exports?.name ?? '?'} apply=${result.exports?.hasApply ? 'yes' : 'no'} tools=[${tools.join(', ')}]`,
      ...(result.warnings?.length ? [`warnings：${result.warnings.join('；')}`] : []),
      result.ok ? '' : `日志尾部：\n${clip(result.log ?? '', 1600)}`,
      result.ok ? '下一步：plugin install（会自动快照 profile；失败自动回滚）。' : '修完再 test；不要用 install 赌运气。',
    ]),
  );
}

// ── install ────────────────────────────────────────────────────────────────
export async function installBundle({ path, name, workspace, cwd, config, ctx, logger }) {
  const creationModule = await creation();
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir === '') return 'plugin install 需要 path 或 name。';
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) return `plugin install 失败：${join(dir, 'package.json')} 不存在或不是合法 JSON。`;
  const packageName = typeof pkg.name === 'string' ? pkg.name : '';
  if (packageName === '') return 'plugin install 失败：package.json 没有 name。';
  const notes = [];

  const report = creationModule.validateBundle(dir);
  if (!report.ok) {
    return output(lines([`❌ 安装前校验不通过（${packageName}），一个字节都没动：`, ...report.errors.map(item => `  - ${item}`)].join('\n')));
  }
  if (report.warnings?.length) notes.push(`校验警告：${report.warnings.join('；')}`);

  // 1) 快照
  let snapshot = null;
  if (config?.snapshotBeforeInstall !== false) {
    snapshot = creationModule.snapshotProfile({ profileDir: profileDir(), outDir: profileSnapshotDir() });
    if (!snapshot.ok) {
      const reason = (snapshot.errors ?? []).join('；');
      if (config?.autoRollback !== false) return `❌ 快照失败，安装中止（没有快照就没有回滚）：${reason}`;
      notes.push(`快照失败（autoRollback 已关，继续）：${reason}`);
    } else {
      notes.push(`快照：${snapshot.file}`);
    }
  }

  // 2) 安装：优先宿主服务，其次退回工具调用
  let installed = false;
  let outcome = '';
  try {
    const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (manager && typeof manager.installBundle === 'function') {
      const result = await manager.installBundle(dir, {});
      installed = true;
      outcome = `宿主 pluginManager 安装完成；activation=${JSON.stringify(result?.activation ?? result?.bundles ?? null)}`;
    }
  } catch (error) {
    notes.push(`pluginManager 服务不可用（${describe(error)}），改用工具通道`);
  }

  if (!installed) {
    return output(
      lines([
        `⚠ plugin install 未执行（本会话拿不到宿主 pluginManager 服务）。`,
        `目标：${dir}`,
        `包名：${packageName}`,
        '',
        '请直接调用宿主工具完成安装（这一步不能被我代劳）：',
        `  plugin_manager({ action: "install_bundle", target: ${JSON.stringify(dir)} })`,
        '装完再回来执行：',
        `  evolve({ action: "plugin", op: "doctor", name: ${JSON.stringify(basename(dir))} })`,
        ...(snapshot?.ok ? [`回滚入口：evolve({ action: "plugin", op: "rollback" })。`] : []),
        ...notes.map(item => `· ${item}`),
      ]),
    );
  }

  // 3) 安装后体检；失败则回滚
  const doctor = creationModule.profileDoctor({ profileDir: profileDir(), packageName });
  const failedChecks = (doctor.checks ?? []).filter(check => check.status === 'fail');
  if (failedChecks.length > 0 && config?.autoRollback !== false && snapshot?.ok) {
    const restored = creationModule.restoreProfile({ profileDir: profileDir(), snapshotFile: snapshot.file });
    return output(
      lines([
        `❌ 安装后体检有 ${failedChecks.length} 项失败，已自动回滚（${restored.ok ? '成功' : '失败'}）：`,
        ...failedChecks.map(check => `  - ${check.id ?? check.name}: ${clip(check.detail ?? check.message ?? '', 200)}`),
        ...(restored.ok ? [`回滚文件：${(restored.restored ?? []).join(', ')}`, '需要重启 DSH 才会完全生效。'] : [`回滚失败：${(restored.errors ?? []).join('；')}`, `手工快照：${snapshot.file}`]),
        ...notes.map(item => `· ${item}`),
      ]),
    );
  }

  return output(
    lines([
      `✅ plugin install：${packageName}`,
      outcome,
      doctor.ok ? `体检 ${doctor.checks?.length ?? 0} 项全部通过` : `体检仍未通过：${failedChecks.map(check => check.id ?? check.name).join(', ')}`,
      ...(doctor.checks ?? []).filter(check => check.status !== 'pass').map(check => `  · ${check.id ?? check.name}: ${check.status} ${clip(check.detail ?? '', 160)}`),
      '',
      '生效条件：装的是新 bundle 时通常要新开一次会话（或重启 DSH）才会出现新模式与工具。',
      ...(!/\bplugin_manager\b/.test('') && notes.length ? notes.map(item => `· ${item}`) : []),
    ]),
  );
}

// ── doctor ─────────────────────────────────────────────────────────────────
export async function profileDoctor({ path, name, workspace, cwd }) {
  const creationModule = await creation();
  let packageName = 'dsh-evolve-ptc';
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir !== '') {
    const pkg = readJson(join(dir, 'package.json'));
    if (typeof pkg?.name === 'string') packageName = pkg.name;
  } else if (String(name ?? '').trim() !== '') {
    packageName = String(name).trim();
  }
  const doctor = creationModule.profileDoctor({ profileDir: profileDir(), packageName });
  return output(
    lines([
      doctor.ok ? `✅ doctor（profile ${profileDir()}，包 ${packageName}）` : `❌ doctor（profile ${profileDir()}，包 ${packageName}）`,
      ...(doctor.checks ?? []).map(check => `${check.status === 'pass' ? '✔' : check.status === 'skip' ? '○' : '✘'} ${check.id ?? check.name}: ${clip(check.detail ?? check.message ?? '', 180)}`),
      ...(doctor.errors?.length ? ['错误：', ...doctor.errors.map(item => `  - ${item}`)] : []),
    ]),
  );
}

// ── rollback ───────────────────────────────────────────────────────────────
export async function rollback({ config } = {}) {
  const creationModule = await creation();
  const dir = profileSnapshotDir();
  if (!existsSync(dir)) return `没有可回滚的快照目录：${dir}`;
  const files = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return `快照目录是空的：${dir}`;
  const latest = join(dir, files[0]);
  const restored = creationModule.restoreProfile({ profileDir: profileDir(), snapshotFile: latest });
  if (!restored.ok) return `❌ 回滚失败（${latest}）：${(restored.errors ?? []).join('；')}`;
  return output(
    lines([
      `✅ 已回滚到 ${latest}`,
      `写回：${(restored.restored ?? []).join(', ')}`,
      ...(config?.autoRollback === false ? [] : []),
      '重启 DSH 后完全生效；如果只是要撤销「启用」而不动依赖，用 plugin_manager 的 set_bundle。',
    ]),
  );
}

// ── list ───────────────────────────────────────────────────────────────────
export async function listWorkspace({ workspace }) {
  const creationModule = await creation();
  const root = workspace ?? '';
  if (root === '') return '工作区路径为空（检查 pluginWorkspace 配置）。';
  const result = creationModule.listWorkspace(root);
  if (!result.ok) return `❌ list ${root}：${(result.errors ?? []).join('；')}`;
  if ((result.items ?? []).length === 0) return `工作区是空的：${root}\n先 evolve({action:"plugin", op:"new", name:"my-plugin", template:"tool"})。`;
  const rows = result.items.map(item => `${item.bundle ? '●' : '○'} ${item.name}${item.version ? `@${item.version}` : ''}${item.packageName ? ` (${item.packageName})` : ''}`);
  return output(lines([`工作区 ${root}（● 可安装的 bundle）：`, ...rows]));
}
