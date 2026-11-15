/**
 * 模块/文件定位器。
 *
 * 为什么需要它：本插件在开发期是 **link 安装**（profile 的 node_modules 指向工作目录），
 * 所以 `createRequire(import.meta.url)` 会从工作目录往上找，永远看不到宿主依赖。
 * 而 DSH 的 `@deepseek-ai/*` 包**根本不在 profile 里**——它们住在安装目录的
 * `resources/app.asar/dsh/node_modules` 下。
 *
 * 因此解析根按可信度排列：
 *   1. 宿主传入的 baseUrl（profile 目录，js-yaml 等第三方依赖在这里）
 *   2. Electron 的 resources 目录里的 asar（宿主自己的包在这里）
 *   3. 本文件目录及其祖先（开发期 `npm install` 装到插件目录时命中）
 *   4. 环境变量 / 进程 cwd
 *
 * 任何一条失败都只返回 null，不抛异常——派生逻辑必须能降级。
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function asDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    if (value.startsWith('file:')) {
      const path = fileURLToPath(value);
      return isAbsolute(path) ? path : null;
    }
    return isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

function ancestorRoots(start, limit = 6) {
  const roots = [];
  let directory = start;
  for (let index = 0; index < limit && directory; index += 1) {
    roots.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
}

/** Electron 主进程里的宿主根：DSH 自己把 `@deepseek-ai/*` 打在 app.asar 里。 */
function electronRoots() {
  const roots = [];
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.trim() !== '') {
    roots.push(join(resources, 'app.asar', 'dsh'));
    roots.push(join(resources, 'app.asar'));
    roots.push(join(resources, 'app.asar.unpacked', 'dsh'));
    roots.push(join(resources, 'dsh'));
  }
  try {
    const execDirectory = dirname(process.execPath);
    roots.push(join(execDirectory, 'resources', 'app.asar', 'dsh'));
    roots.push(join(execDirectory, 'resources', 'app.asar'));
  } catch {
    // 非文件型 execPath（测试桩）忽略。
  }
  return roots;
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 收集候选解析根：宿主 baseUrl → Electron asar → 本文件祖先 → 环境变量 / cwd。 */
export function collectRoots(ctx) {
  const candidates = [];
  candidates.push(asDirectory(ctx?.baseUrl));
  candidates.push(...electronRoots());
  candidates.push(...ancestorRoots(dirname(fileURLToPath(import.meta.url)), 6));
  candidates.push(asDirectory(process.env.DSH_PROFILE_DIR));
  candidates.push(asDirectory(process.env.DSH_HOME) ? join(process.env.DSH_HOME.trim(), 'profiles', process.env.DSH_PROFILE ?? 'desktop') : null);
  candidates.push(asDirectory(process.cwd()));
  return unique(candidates.filter(Boolean));
}

function makeRequire(root) {
  try {
    return createRequire(join(root, '__evolve_ptc_resolver__.cjs'));
  } catch {
    return null;
  }
}

export function createResolver(ctx) {
  const roots = collectRoots(ctx);
  const requires = roots.map(root => makeRequire(root)).filter(Boolean);

  /** 解析一个模块/子路径为绝对文件路径；失败返回 null。 */
  function resolve(specifier) {
    if (typeof specifier !== 'string' || specifier === '') return null;
    for (const requireFrom of requires) {
      try {
        return requireFrom.resolve(specifier);
      } catch {
        // 换下一个根继续找。
      }
    }
    // 退路：按 node_modules 目录形状直接拼路径（处理未在 exports 里声明的子文件）。
    const segments = specifier.split('/');
    for (const root of roots) {
      const candidate = join(root, 'node_modules', ...segments);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** 读一个模块子路径的文本（YAML/JSON 预设文档）；失败返回 null。 */
  function readText(specifier) {
    const file = resolve(specifier);
    if (!file) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /** 直接读一个绝对路径的文本；失败返回 null。 */
  function readPath(file) {
    try {
      const path = asDirectory(file) ?? file;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  /** require 一个 CJS 模块；失败返回 null。 */
  function requireModule(specifier) {
    for (const requireFrom of requires) {
      try {
        return requireFrom(specifier);
      } catch {
        // 换下一个根继续找。
      }
    }
    return null;
  }

  let yaml;
  let yamlTried = false;
  /** 加载 js-yaml：先按 CJS require，再按解析到的入口动态 import。 */
  async function loadYaml() {
    if (yamlTried) return yaml;
    yamlTried = true;
    const required = requireModule('js-yaml');
    if (required && typeof required.load === 'function') {
      yaml = required;
      return yaml;
    }
    const entry = resolve('js-yaml');
    if (entry) {
      try {
        const imported = await import(pathToFileURL(entry).href);
        const namespace = imported && typeof imported.load === 'function' ? imported : imported?.default;
        if (namespace && typeof namespace.load === 'function') yaml = namespace;
      } catch {
        yaml = undefined;
      }
    }
    return yaml;
  }

  return { roots, resolve, readText, readPath, requireModule, loadYaml };
}
