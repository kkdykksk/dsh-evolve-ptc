/**
 * 运行期状态目录。所有跨会话的东西都落在 `$DSH_HOME/evolve/` 下，**绝不写 profile 的
 * node_modules**（本地目录安装是 link，写进去等于改仓库）。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH_HOME 与宿主保持同一口径：环境变量优先，否则 `~/.dsh`。 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  return configured && configured.trim() ? configured.trim() : join(homedir(), '.dsh');
}

/** 状态根：`EVOLVE_ROOT` 优先（自检/测试用），否则 `$DSH_HOME/evolve`。 */
export function evolveRoot() {
  const configured = process.env.EVOLVE_ROOT;
  if (configured && configured.trim()) return configured.trim();
  return join(dshHome(), 'evolve');
}

/** 生命周期日志：注册/派生/安装的关键节点都往这里追加一行，排障时先看它。 */
export function statusLogFile() {
  return join(evolveRoot(), 'status.log');
}

const safeName = value => String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || 'unknown';

export function ledgerFile(sessionId) {
  return join(evolveRoot(), 'ledgers', `${safeName(sessionId)}.jsonl`);
}

export function rulesFile(scope) {
  return join(evolveRoot(), 'rules', `${safeName(scope)}.json`);
}

export function workspaceDir(config) {
  const configured = config && typeof config.pluginWorkspace === 'string' ? config.pluginWorkspace.trim() : '';
  return configured || join(evolveRoot(), 'workspace');
}

export function snapshotFile() {
  return join(evolveRoot(), 'preset.snapshot.json');
}

export function profileSnapshotDir() {
  return join(evolveRoot(), 'profile-snapshots');
}

export function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
  return directory;
}
