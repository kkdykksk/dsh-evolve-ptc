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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dshHome, profileSnapshotDir } from './paths.mjs';

const clip = (value, limit) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};
const describe = error => (error instanceof Error ? error.message : String(error));
const lines = parts => (Array.isArray(parts) ? parts : [parts]).filter(part => part !== '' && part !== null && part !== undefined).join('\n');
const isInside = (root, target) => {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** 把 creation.profileDoctor 的 `{name, ok, detail}` 统一成安装流程使用的 `{id,name,status,detail}`。 */
function doctorChecks(doctor) {
  return (doctor?.checks ?? []).map(check => ({
    id: check.id ?? check.name ?? '?',
    name: check.name ?? check.id ?? '?',
    status: check.status ?? (check.ok === false ? 'fail' : check.skipped ? 'skip' : 'pass'),
    detail: check.detail ?? check.message ?? '',
  }));
}

/** profile 目录：环境变量优先（宿主注入），否则按 DSH_HOME 推。 */
export function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR;
  // 显式指定就按指定来：静默退回 desktop 会把快照/安装写到另一个 profile。
  if (explicit && explicit.trim() !== '') return resolve(explicit.trim());
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
export async function scaffold({ path, name, template, text, overwrite: overwriteRequested, workspace, cwd, logger }) {
  const creationModule = await creation();
  const templateName = String(template ?? 'tool').trim() || 'tool';
  const dir = targetDir({ path, name, workspace, cwd });
  if (dir === '') return 'plugin new 需要 name 或 path（name 是插件目录名）。';
  const workspaceRoot = resolve(workspace ?? cwd ?? process.cwd());
  if (!isInside(workspaceRoot, dir)) {
    return output(`❌ plugin new 拒绝写入工作区之外的路径：${dir}（工作区 ${workspaceRoot}）`);
  }
  const { root, name: leaf } = splitTarget(dir);
  const overwrite = overwriteRequested === true;
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
  let managerAttempted = false;
  let outcome = '';
  try {
    const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (manager && typeof manager.installBundle === 'function') {
      managerAttempted = true;
      const result = await manager.installBundle(dir, {});
      // 宿主的 ChangeResult 用 application 表达结论；await 成功只代表「流程跑完」，
      // 不代表「装上了」。把 failed/cancelled 当成成功会让人以为 profile 变了。
      const application = typeof result?.application === 'string' ? result.application : '';
      // await 成功只代表流程跑完；application 为空/undefined 绝不能当成「已应用」，
      // 否则宿主什么都没做也被报告成功（v0.1.3 实测）。
      const applied = application === 'applied' || application === 'restart-required';
      if (!applied) {
        const reason = result?.error?.message ?? result?.error?.code ?? application ?? '无返回值';
        notes.push(`宿主安装未生效（application=${application || '空'}）：${reason}`);
      } else {
        installed = true;
        outcome = `宿主 pluginManager 安装完成；application=${application}`;
        if (result?.warnings?.length) notes.push(`宿主警告：${result.warnings.join('；')}`);
      }
    }
  } catch (error) {
    notes.push(`pluginManager 调用失败（${describe(error)}）`);
  }

  if (!installed) {
    return output(
      lines([
        managerAttempted
          ? `❌ plugin install 未生效：宿主 pluginManager 返回失败，profile 没有被改动。`
          : `⚠ plugin install 未执行（本会话拿不到宿主 pluginManager 服务）。`,
        `目标：${dir}`,
        `包名：${packageName}`,
        ...(managerAttempted ? ['先看下面的失败原因；修好后重试。'] : ['', '请直接调用宿主工具完成安装（这一步不能被我代劳）：', `  plugin_manager({ action: "install_bundle", target: ${JSON.stringify(dir)} })`, '装完再回来执行：', `  evolve({ action: "plugin", op: "doctor", name: ${JSON.stringify(basename(dir))} })`]),
        ...(snapshot?.ok ? [`回滚入口：evolve({ action: "plugin", op: "rollback" })。`] : []),
        ...notes.map(item => `· ${item}`),
      ]),
    );
  }

  // 3) 安装后体检；失败则回滚
  const doctor = creationModule.profileDoctor({ profileDir: profileDir(), packageName });
  const checks = doctorChecks(doctor);
  const failedChecks = checks.filter(check => check.status === 'fail');
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
      `${doctor.ok ? '✅' : '⚠'} plugin install：${packageName}${doctor.ok ? '' : '（体检未通过，见下）'}`,
      outcome,
      doctor.ok ? `体检 ${checks.length} 项全部通过` : `体检仍未通过：${failedChecks.map(check => check.id).join(', ')}${config?.autoRollback === false ? '；autoRollback=false，未回滚' : ''}`,
      ...checks.filter(check => check.status !== 'pass').map(check => `  · ${check.id}: ${check.status} ${clip(check.detail ?? '', 160)}`),
      '',
      '生效条件：装的是新 bundle 时通常要新开一次会话（或重启 DSH）才会出现新模式与工具。',
      ...notes.map(item => `· ${item}`),
    ]),
  );
}

// ── doctor ─────────────────────────────────────────────────────────────────
export async function profileDoctor({ path, name, workspace, cwd }) {
  const creationModule = await creation();
  const dir = targetDir({ path, name, workspace, cwd });
  const pkg = dir === '' ? null : readJson(join(dir, 'package.json'));
  let packageName = '';
  if (typeof pkg?.name === 'string') packageName = pkg.name;
  else if (String(name ?? '').trim() !== '') packageName = String(name).trim();
  else packageName = 'dsh-evolve-ptc'; // 不带参数 = 体检本插件自身
  if (dir !== '' && !pkg && String(name ?? '').trim() === '' && String(path ?? '').trim() !== '') {
    return `❌ doctor：${dir} 下没有可读的 package.json。`;
  }
  const doctor = creationModule.profileDoctor({ profileDir: profileDir(), packageName });
  const checks = doctorChecks(doctor);
  return output(
    lines([
      doctor.ok ? `✅ doctor（profile ${profileDir()}，包 ${packageName}）` : `❌ doctor（profile ${profileDir()}，包 ${packageName}）`,
      ...checks.map(check => `${check.status === 'pass' ? '✔' : check.status === 'skip' ? '○' : '✘'} ${check.id}: ${clip(check.detail ?? '', 180)}`),
      ...(doctor.errors?.length ? ['错误：', ...doctor.errors.map(item => `  - ${item}`)] : []),
    ]),
  );
}

// ── rollback ───────────────────────────────────────────────────────────────
export async function rollback({ config, path, name, workspace, cwd } = {}) {
  const creationModule = await creation();
  const currentProfile = resolve(profileDir());
  const dir = profileSnapshotDir();
  if (!existsSync(dir)) return `没有可回滚的快照目录：${dir}`;
  const requestedDir = targetDir({ path, name, workspace, cwd });
  let packageName = '';
  if (requestedDir !== '') {
    const pkg = readJson(join(requestedDir, 'package.json'));
    if (typeof pkg?.name === 'string') packageName = pkg.name;
  }
  const files = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .reverse();
  const candidates = [];
  for (const file of files) {
    const snapshot = readJson(join(dir, file));
    if (!snapshot || typeof snapshot !== 'object') continue;
    // 只回滚到「同一个 profile」的快照：别的 profile 的文件写回来只会制造半坏状态。
    // Windows 盘符大小写 / 斜杠差异会导致字符串不等，统一规范化后再比。
    const normProfile = value => {
      const resolved = resolve(String(value ?? ''));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (snapshot.profileDir && normProfile(snapshot.profileDir) !== normProfile(currentProfile)) continue;
    const manifest = (snapshot.files ?? []).find(entry => basename(String(entry.name ?? '')) === 'package.json');
    const pkg = manifest ? (() => { try { return JSON.parse(String(manifest.content ?? '')); } catch { return null; } })() : null;
    // 用精确结构判断包名是否存在，不能用 JSON 文本子串（"foo" 会命中 "foobar"）。
    const deps = pkg && typeof pkg === 'object' && pkg.dependencies && typeof pkg.dependencies === 'object'
      ? pkg.dependencies : {};
    const bundles = pkg && Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const hasPackage = packageName !== '' && (
      Object.prototype.hasOwnProperty.call(deps, packageName)
      || bundles.some(item => String(item) === packageName)
    );
    candidates.push({ file, snapshot, hasPackage });
  }
  if (candidates.length === 0) return `没有匹配当前 profile 的快照：${dir}`;
  // 回滚到「安装前」才有意义：安装前的 package.json 里当然没有这个包名。
  // 优先选不含该包的快照；都不含时退回最新同 profile 快照（用户可能只是想撤销后续改动）。
  const preInstall = packageName === '' ? candidates : candidates.filter(item => !item.hasPackage);
  const pool = preInstall.length > 0 ? preInstall : candidates;
  const latest = join(dir, pool[0].file);
  const restored = creationModule.restoreProfile({ profileDir: currentProfile, snapshotFile: latest });
  if (!restored.ok) return `❌ 回滚失败（${latest}）：${(restored.errors ?? []).join('；')}`;
  const doctor = creationModule.profileDoctor({ profileDir: currentProfile, packageName: packageName || 'dsh-evolve-ptc' });
  const checks = doctorChecks(doctor);
  return output(
    lines([
      `✅ 已回滚到 ${latest}`,
      `写回：${(restored.restored ?? []).join(', ')}`,
      ...(restored.warnings?.length ? ['回滚警告：', ...restored.warnings.map(item => `  - ${item}`)] : []),
      `回滚后体检：${doctor.ok ? '通过' : '未通过'}`,
      ...checks.filter(check => check.status !== 'pass').map(check => `  · ${check.id}: ${check.status} ${clip(check.detail ?? '', 160)}`),
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
