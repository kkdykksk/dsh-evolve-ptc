/**
 * 创造模式（creation mode）核心模块。
 *
 * 给 agent 运行时用的一组「建 → 验 → 冒烟 → 装 → 回滚」原语：
 *
 * | 导出 | 作用 |
 * | --- | --- |
 * | `planScaffold` | 干跑：算出要写哪些文件、各多少字节，不落盘 |
 * | `scaffold` | 真正建目录 + 写文件（模板见 creation-templates.mjs） |
 * | `validateBundle` | 静态体检：package.json / patch YAML / 行 name / 预设 / 语法 |
 * | `smokeTest` | 真跑：node 子进程 + 桩 ctx 实际 import 入口并调用 apply |
 * | `snapshotProfile` | 备份 profile 的 package.json + cordis.patch.yml |
 * | `restoreProfile` | 只从快照恢复（不猜测、不合并） |
 * | `profileDoctor` | 查一个包是否真的被 profile 装上/挂上 |
 * | `listWorkspace` | 列出 root 下哪些子目录像 DSH bundle |
 *
 * 三条铁律：
 * 1. **永不抛异常**：每个导出函数整体包在 try/catch 里，出错也要返回结构化结果
 *    （`ok: false` + `errors: [...]`），因为调用方是 agent 运行时，一次抛出会打断服务。
 * 2. **写盘不出 root**：所有写操作先 `path.resolve`，再用前缀校验确认落在给定目录内，
 *    防 `../` 目录穿越；覆盖已存在文件必须显式 `overwrite: true`。
 * 3. **只读真实 profile**：doctor 只读 `profileDir` 下的 package.json 与 cordis.patch.yml；
 *    restore 只从快照写回。不跑 `npm install`、不联网。
 *
 * YAML 校验依赖 `js-yaml`（包已声明依赖）。导入失败时**不崩**：降级成
 * 「YAML 无法校验」的 warning，并退化为纯文本粗检（tab 缩进检查）。
 *
 * 另外：DSH 的 patch 允许 `!!js <表达式>` 这种宿主侧求值的标签，标准 `js-yaml.load`
 * 遇到它会抛 `unknown tag !<tag:yaml.org,2002:js>`。这里先严格解析，失败则把这些
 * 标签替换成字符串占位再解析一次，并记一条 warning——否则任何带 `!!js` 的官方
 * patch 都会被误判成「YAML 坏了」。
 *
 * @module dsh-evolve-ptc/creation
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { getTemplate, TEMPLATE_NAMES, TEMPLATES, toolIdentifier } from './creation-templates.mjs'

/** npm 包名 / preset id 都要求：小写字母开头，只含小写字母数字与连字符。 */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** npm 包名最大长度。 */
const NAME_MAX = 64

/** `cordis:group` 这类合法分组行的名字前缀。 */
const CORDIS_PREFIX = 'cordis:'

// ---------------------------------------------------------------------------
// js-yaml：可选依赖，导入失败降级
// ---------------------------------------------------------------------------

/** @type {{ load: (text: string) => unknown } | null} */
let yaml = null

/** js-yaml 不可用的原因（用于 warning 文案）。 */
let yamlUnavailableReason = ''

try {
  const imported = await import('js-yaml')
  const candidate = imported?.default ?? imported
  if (candidate && typeof candidate.load === 'function') {
    yaml = candidate
  } else {
    yamlUnavailableReason = 'js-yaml 导出形状不认识（缺少 load 函数）'
  }
} catch (error) {
  yamlUnavailableReason = `无法导入 js-yaml：${errorText(error)}`
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 把任意抛出的东西变成一行文本。
 * @param {unknown} error - catch 到的东西。
 * @returns {string} 可读消息。
 */
function errorText(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/**
 * 只接受字符串，其它一律当空串，避免 `path.resolve(undefined)` 用到 cwd。
 * @param {unknown} value - 任意值。
 * @returns {string} 字符串或空串。
 */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 判断 `target` 是否在 `root` 之内（含 root 本身）。
 * @param {string} root - 已 resolve 的根目录。
 * @param {string} target - 已 resolve 的目标路径。
 * @returns {boolean} 在里面返回 true。
 */
function isInside(root, target) {
  const relative = path.relative(root, target)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 把绝对路径转成相对 root 的 posix 风格路径（用于对外的 `created` 列表）。
 * @param {string} root - 根目录。
 * @param {string} target - 目标路径。
 * @returns {string} 形如 `lib/index.mjs`。
 */
function toPosixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

/** 文件是否存在（不抛异常）。 @param {string} file - 路径。 @returns {boolean} */
function fileExists(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 目录是否存在。 @param {string} dir - 路径。 @returns {boolean} */
function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读一个 JSON 文件。
 * @param {string} file - 绝对路径。
 * @returns {{ ok: boolean, value: any, error: string }} 解析结果。
 */
function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return { ok: true, value: JSON.parse(raw), error: '' }
  } catch (error) {
    return { ok: false, value: null, error: errorText(error) }
  }
}

/**
 * 把 `!!js` 宿主表达式标签替换成字符串占位，让标准 YAML 解析器还能读。
 * @param {string} source - 原始 YAML 文本。
 * @returns {string} 替换后的文本。
 */
function stripHostJsTags(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)!!js(?:\/[A-Za-z0-9_./-]+)?(?:\s+[^\n]*)?$/u, '$1"<!!js expression>"'))
    .join('\n')
}

/**
 * 解析一段 YAML。
 *
 * 三级策略：严格 → 去掉 `!!js` 再解析（degraded）→ 失败。没有 js-yaml 时返回
 * `unavailable: true`，由调用方降级成 warning。
 * @param {string} source - YAML 文本。
 * @returns {{ ok: boolean, value?: unknown, error?: string, unavailable?: boolean, degraded?: boolean }} 解析结果。
 */
function parseYaml(source) {
  if (!yaml) return { ok: false, unavailable: true, error: yamlUnavailableReason || 'js-yaml 不可用' }
  try {
    return { ok: true, value: yaml.load(source) }
  } catch (strictError) {
    try {
      return { ok: true, value: yaml.load(stripHostJsTags(source)), degraded: true }
    } catch (lenientError) {
      return { ok: false, error: `${errorText(strictError)}；去 !!js 后仍失败：${errorText(lenientError)}` }
    }
  }
}

/**
 * 没有 YAML 解析器时的纯文本粗检：只抓最常见、最确定的错误。
 * @param {string} source - YAML 文本。
 * @returns {string[]} 问题列表（空数组表示粗检通过）。
 */
function lintYamlText(source) {
  /** @type {string[]} */
  const problems = []
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) return
    if (line.includes('\t')) problems.push(`第 ${index + 1} 行含 tab（YAML 只允许空格缩进）`)
    const indent = line.length - line.trimStart().length
    if (line.trim() !== '' && indent % 2 !== 0) problems.push(`第 ${index + 1} 行缩进 ${indent} 不是 2 的倍数`)
  })
  return problems
}

/**
 * 判断一个 patch 节点是不是「行」（loader row）。
 *
 * 只把真正的行当成行来要求 `name`：带 `id`、带 `group`、或出现在 `insert` /
 * `config`（group 子行）/ `config.plugins`（预设子行）里的对象。普通 `config`
 * 数据对象（比如模型列表、路径配置）不算行，避免误报。
 * @param {Record<string, any>} node - 待判定对象。
 * @returns {boolean} 是行返回 true。
 */
function isRowLike(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  if (typeof node.name === 'string') return true
  if (typeof node.id === 'string') return true
  if (node.group === true) return true
  return false
}

/**
 * 判断一行是不是合法的 `cordis:group` 分组行。
 * @param {Record<string, any>} node - 行对象。
 * @returns {boolean} 合法返回 true。
 */
function isCordisGroup(node) {
  return node?.group === true && typeof node?.name === 'string' && node.name.startsWith(CORDIS_PREFIX)
}

/**
 * 遍历 patch 里所有行，收集到 `rows` 里，并记录重复 id。
 *
 * 覆盖的位置：顶层元素、`insert` 数组、`config`（分组行的子行是数组）、
 * `config.plugins`（agent-preset 的子行是数组）。
 * @param {unknown} data - `yaml.load` 的结果。
 * @param {(node: Record<string, any>, where: string) => void} visit - 命中一行的回调。
 * @returns {{ rows: number, duplicates: string[] }} 统计与重复 id。
 */
function walkPatch(data, visit) {
  /** @type {Map<string, number>} */
  const seen = new Map()
  /** @type {string[]} */
  const duplicates = []
  let rows = 0

  /**
   * 递归入口。
   * @param {unknown} node - 任意节点。
   * @param {string} where - 位置描述（报错用）。
   * @returns {void}
   */
  const walk = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    if (isRowLike(node)) {
      rows += 1
      if (typeof node.id === 'string') {
        const count = (seen.get(node.id) ?? 0) + 1
        seen.set(node.id, count)
        if (count === 2) duplicates.push(node.id)
      }
      visit(node, where)
    }
    if (Array.isArray(node.insert)) {
      node.insert.forEach((child, index) => walk(child, `${where}.insert[${index}]`))
    }
    if (Array.isArray(node.config)) {
      node.config.forEach((child, index) => walk(child, `${where}.config[${index}]`))
    } else if (node.config && typeof node.config === 'object' && Array.isArray(node.config.plugins)) {
      node.config.plugins.forEach((child, index) => walk(child, `${where}.config.plugins[${index}]`))
    }
  }

  if (Array.isArray(data)) data.forEach((node, index) => walk(node, `[${index}]`))
  else walk(data, '$')

  return { rows, duplicates }
}

/**
 * 取 `exports` 字段里某个 key 指向的文件（兼容字符串和条件导出对象）。
 * @param {unknown} exportsField - package.json 的 exports。
 * @param {string} key - `.` 或 `./client`。
 * @returns {string | null} 相对路径或 null。
 */
function exportsEntry(exportsField, key) {
  if (typeof exportsField === 'string') return key === '.' ? exportsField : null
  if (!exportsField || typeof exportsField !== 'object') return null
  const value = /** @type {Record<string, unknown>} */ (exportsField)[key]
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const conditions = /** @type {Record<string, unknown>} */ (value)
    for (const condition of ['import', 'default', 'require', 'node']) {
      if (typeof conditions[condition] === 'string') return conditions[condition]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// planScaffold
// ---------------------------------------------------------------------------

/**
 * 校验并归一化打包参数（planScaffold / scaffold 共用）。
 * @param {{ root: unknown, name: unknown, template: unknown }} input - 原始参数。
 * @returns {{ ok: boolean, root: string, name: string, template: string, errors: string[] }} 归一化结果。
 */
function normalizeScaffoldInput({ root, name, template }) {
  /** @type {string[]} */
  const errors = []
  const rootText = asText(root)
  const nameText = asText(name)
  const templateText = asText(template)

  if (rootText === '') errors.push('root 必须是非空字符串')

  if (nameText === '') {
    errors.push('name 必须是非空字符串')
  } else if (!NAME_PATTERN.test(nameText)) {
    errors.push(`name 不合法：${nameText}（只允许小写字母开头的小写字母、数字与连字符）`)
  } else if (nameText.length > NAME_MAX) {
    errors.push(`name 太长：${nameText.length} 字符（上限 ${NAME_MAX}）`)
  } else if (nameText.endsWith('-')) {
    errors.push(`name 不能以连字符结尾：${nameText}`)
  }

  if (templateText === '') {
    errors.push(`template 必须是非空字符串（可选：${TEMPLATE_NAMES.join(' / ')}）`)
  } else if (!getTemplate(templateText)) {
    errors.push(`未知模板：${templateText}（可选：${TEMPLATE_NAMES.join(' / ')}）`)
  }

  return {
    ok: errors.length === 0,
    root: rootText === '' ? '' : path.resolve(rootText),
    name: nameText,
    template: templateText,
    errors,
  }
}

/**
 * 把 kebab-case 包名变成显示名：`demo-plugin` → `Demo Plugin`。
 * @param {string} name - 包名。
 * @returns {string} 显示名。
 */
function displayNameFrom(name) {
  const words = name.split('-').filter(Boolean)
  if (words.length === 0) return name
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * 干跑脚手架：算出要写哪些文件、各多少字节，**不落盘**。
 *
 * 用途：让 agent 在真正写文件前先给用户看一份清单，或做「会不会覆盖」的预判。
 * @param {{ root: string, name: string, template: string }} options - 目标根目录、包名、模板名。
 * @returns {{ ok: boolean, files: Array<{ path: string, relativePath: string, bytes: number, exists: boolean }>, errors: string[] }}
 *   `ok: false` 时 `errors` 说明原因；`files` 里的 `path` 是绝对路径。
 */
export function planScaffold({ root, name, template } = /** @type {any} */ ({})) {
  try {
    const normalized = normalizeScaffoldInput({ root, name, template })
    if (!normalized.ok) return { ok: false, files: [], errors: normalized.errors }

    const builder = getTemplate(normalized.template)
    if (!builder) return { ok: false, files: [], errors: [`未知模板：${normalized.template}`] }

    const targetDir = path.resolve(normalized.root, normalized.name)
    if (!isInside(normalized.root, targetDir)) {
      return { ok: false, files: [], errors: [`目标目录越界：${targetDir} 不在 ${normalized.root} 之内`] }
    }

    const generated = builder({
      name: normalized.name,
      displayName: displayNameFrom(normalized.name),
      packageName: normalized.name,
    })
    if (!Array.isArray(generated) || generated.length === 0) {
      return { ok: false, files: [], errors: [`模板 ${normalized.template} 没有产出任何文件`] }
    }

    /** @type {Array<{ path: string, relativePath: string, bytes: number, exists: boolean }>} */
    const files = []
    /** @type {string[]} */
    const errors = []
    for (const file of generated) {
      const relativePath = asText(file?.relativePath)
      if (relativePath === '' || typeof file?.content !== 'string') {
        errors.push('模板产出了非法文件（缺少 relativePath 或 content）')
        continue
      }
      const absolute = path.resolve(targetDir, relativePath)
      if (!isInside(normalized.root, absolute)) {
        errors.push(`模板产出的路径越界：${relativePath}`)
        continue
      }
      files.push({
        path: absolute,
        relativePath: toPosixRelative(targetDir, absolute),
        bytes: Buffer.byteLength(file.content, 'utf8'),
        exists: fileExists(absolute),
      })
    }

    return { ok: errors.length === 0, files, errors }
  } catch (error) {
    return { ok: false, files: [], errors: [`planScaffold 失败：${errorText(error)}`] }
  }
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

/**
 * 真正建包：目录 + `package.json` + `cordis.patch.yml` + `lib/index.mjs` + `README.md`
 * （`bundle` 模板没有 `lib/`）。
 *
 * 先整体预检（全部文件是否已存在、路径是否越界），预检不过就一个字节都不写，
 * 避免半成品目录。root 不存在时会连同父目录一起创建。
 * @param {{ root: string, name: string, template: string, overwrite?: boolean }} options
 *   `overwrite: true` 才允许覆盖已存在文件（默认 false）。
 * @returns {{ ok: boolean, dir: string, created: string[], errors: string[], warnings: string[] }}
 *   `created` 是相对包目录的 posix 路径；失败时 `dir` 仍返回计划目录便于排查。
 */
export function scaffold({ root, name, template, overwrite = false } = /** @type {any} */ ({})) {
  try {
    const plan = planScaffold({ root, name, template })
    if (!plan.ok || plan.files.length === 0) {
      return { ok: false, dir: '', created: [], errors: plan.errors, warnings: [] }
    }

    /** @type {string[]} */
    const errors = []
    /** @type {string[]} */
    const warnings = []
    const targetDir = path.dirname(plan.files[0].path)
    const allowOverwrite = overwrite === true

    for (const file of plan.files) {
      if (file.exists && !allowOverwrite) errors.push(`已存在，拒绝覆盖（需要 overwrite: true）：${file.relativePath}`)
    }

    if (errors.length > 0) {
      return { ok: false, dir: targetDir, created: [], errors, warnings }
    }

    fs.mkdirSync(targetDir, { recursive: true })

    /** @type {string[]} */
    const created = []
    for (const file of plan.files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true })
      const builder = getTemplate(asText(template))
      const generated = builder
        ? builder({ name: asText(name), displayName: displayNameFrom(asText(name)), packageName: asText(name) })
        : []
      const match = generated.find((entry) => {
        const absolute = path.resolve(targetDir, asText(entry?.relativePath))
        return absolute === file.path
      })
      if (!match) {
        errors.push(`内部错误：模板内容在写入阶段丢失（${file.relativePath}）`)
        continue
      }
      fs.writeFileSync(file.path, match.content, 'utf8')
      created.push(file.relativePath)
    }

    if (errors.length > 0) return { ok: false, dir: targetDir, created, errors, warnings }
    return { ok: true, dir: targetDir, created, errors, warnings }
  } catch (error) {
    return { ok: false, dir: '', created: [], errors: [`scaffold 失败：${errorText(error)}`], warnings: [] }
  }
}

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

/**
 * 用 `node --check` 给一个 JS 文件做语法检查。
 *
 * 不同 Node 版本对 ESM 的 check 行为不一致（`.js` 里的 ESM 可能报 `ERR_*`），
 * 所以「stderr 不含 SyntaxError 但含 ERR_*」降级为 warning，而不是 error。
 * @param {string} file - 绝对路径。
 * @returns {{ ok: boolean, warning: boolean, detail: string }} 结果。
 */
function checkSyntax(file) {
  try {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 })
    const stdout = asText(result.stdout)
    const stderr = asText(result.stderr)
    if (result.error) return { ok: false, warning: true, detail: `无法执行 node --check：${errorText(result.error)}` }
    if (result.status === 0) return { ok: true, warning: false, detail: '语法通过' }
    const combined = `${stderr}${stdout}`
    if (!combined.includes('SyntaxError') && /ERR_[A-Z_]+/.test(combined)) {
      const code = /ERR_[A-Z_]+/.exec(combined)?.[0] ?? 'ERR_*'
      return { ok: true, warning: true, detail: `node --check 报 ${code} 但无 SyntaxError，按 Node 版本差异降级为 warning` }
    }
    const firstLine = combined.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '未知错误'
    return { ok: false, warning: false, detail: firstLine }
  } catch (error) {
    return { ok: false, warning: true, detail: `node --check 异常：${errorText(error)}` }
  }
}

/**
 * 静态体检一个 bundle 目录（不执行代码）。
 *
 * 检查项（全部逐条落地，失败进 `errors`，可疑进 `warnings`）：
 * 1. `package.json` 存在、JSON 可解析、`type === 'module'`、`name` 非空；
 * 2. `dsh.bundle.patch` 存在且指向的文件存在、YAML 可解析、顶层是数组、
 *    每个元素要么有 `insert` 数组要么有 `id` 字符串；
 * 3. 所有行（`insert` 内、`config` 内的分组子行、`config.plugins` 里的预设子行）
 *    都有非空字符串 `name`，`cordis:*` 分组行除外；
 * 4. `@deepseek-ai/dsh-agent-preset` 行：`config.id` 匹配 `/^[a-z][a-z0-9-]*$/`、
 *    `config.plugins` 是非空数组、每个子行有非空 `name`，并收集 `presetIds`；
 * 5. `main` 指向的文件存在；`exports['./client']` 若声明则文件必须存在；
 * 6. 入口 JS 用 `node --check` 查语法（ESM `ERR_*` 降级为 warning）；
 * 7. `dsh.client.platform` 存在但不是 `'web'` → warning。
 * @param {string} dir - 包目录。
 * @returns {{ ok: boolean, errors: string[], warnings: string[], manifest: { name: string | null, hasPreset: boolean, presetIds: string[], hasClient: boolean, patchPath: string | null } }}
 *   结构化的体检报告；`ok` 表示没有 error。
 */
export function validateBundle(dir) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {{ name: string | null, hasPreset: boolean, presetIds: string[], hasClient: boolean, patchPath: string | null }} */
  const manifest = { name: null, hasPreset: false, presetIds: [], hasClient: false, patchPath: null }

  try {
    const dirText = asText(dir)
    if (dirText === '') {
      return { ok: false, errors: ['dir 必须是非空字符串'], warnings, manifest }
    }
    const root = path.resolve(dirText)
    if (!dirExists(root)) {
      return { ok: false, errors: [`目录不存在：${root}`], warnings, manifest }
    }

    // ---- 检查 1：package.json ----
    const pkgPath = path.join(root, 'package.json')
    if (!fileExists(pkgPath)) {
      return { ok: false, errors: ['缺少 package.json'], warnings, manifest }
    }
    const pkgResult = readJsonFile(pkgPath)
    if (!pkgResult.ok) {
      return { ok: false, errors: [`package.json 不是合法 JSON：${pkgResult.error}`], warnings, manifest }
    }
    /** @type {Record<string, any>} */
    const pkg = pkgResult.value && typeof pkgResult.value === 'object' ? pkgResult.value : {}
    if (pkg.type !== 'module') errors.push(`package.json 的 type 必须是 'module'（实际：${JSON.stringify(pkg.type)}）`)
    if (typeof pkg.name !== 'string' || pkg.name.trim() === '') errors.push('package.json 的 name 必须是非空字符串')
    else manifest.name = pkg.name
    if (typeof pkg.version !== 'string' || pkg.version.trim() === '') warnings.push('package.json 没有声明 version')

    // ---- 检查 2 + 3 + 4：patch ----
    const patchSpec = pkg?.dsh?.bundle?.patch
    if (typeof patchSpec !== 'string' || patchSpec.trim() === '') {
      errors.push('package.json 未声明 dsh.bundle.patch（应为 "./cordis.patch.yml"）')
    } else {
      const patchPath = path.resolve(root, patchSpec)
      manifest.patchPath = toPosixRelative(root, patchPath)
      if (!isInside(root, patchPath)) warnings.push(`dsh.bundle.patch 指向包外：${patchSpec}`)
      if (!fileExists(patchPath)) {
        errors.push(`dsh.bundle.patch 指向的文件不存在：${patchSpec}`)
      } else {
        let patchText = ''
        try {
          patchText = fs.readFileSync(patchPath, 'utf8')
        } catch (error) {
          errors.push(`无法读取 patch 文件：${errorText(error)}`)
        }

        if (patchText !== '') {
          if (!yaml) {
            warnings.push(`YAML 无法校验（${yamlUnavailableReason || 'js-yaml 不可用'}），仅做纯文本粗检`)
            for (const problem of lintYamlText(patchText)) warnings.push(`patch 粗检：${problem}`)
          }
          const parsed = parseYaml(patchText)
          if (parsed.unavailable) {
            // 上面已经记过 warning，这里不再重复。
          } else if (!parsed.ok) {
            errors.push(`cordis.patch.yml 不是合法 YAML：${parsed.error}`)
          } else {
            if (parsed.degraded) {
              warnings.push('patch 含 !!js 宿主表达式，标准解析失败后已按去标签模式解析（行结构仍可信）')
            }
            const data = parsed.value
            if (!Array.isArray(data)) {
              errors.push(`cordis.patch.yml 顶层必须是数组（实际：${data === null ? 'null' : typeof data}）`)
            } else {
              for (const [index, node] of data.entries()) {
                if (!node || typeof node !== 'object' || Array.isArray(node)) {
                  errors.push(`cordis.patch.yml 第 ${index + 1} 个元素不是对象（插件行或 { insert: [...] }）`)
                  continue
                }
                if (!Array.isArray(node.insert) && typeof node.id !== 'string') {
                  errors.push(`cordis.patch.yml 第 ${index + 1} 个元素既没有 insert 数组也没有 id 字符串`)
                }
              }
            }

            // 逐行走查（顶层 / insert / config / config.plugins）
            const walked = walkPatch(data, (node, where) => {
              const name = node.name
              if (typeof name !== 'string' || name.trim() === '') {
                if (isCordisGroup(node)) return
                errors.push(`${where} 这一行缺少非空字符串 name`)
                return
              }
              if (node.group === true && !isCordisGroup(node)) {
                warnings.push(`${where}: group: true 但 name 不是 cordis:*（现在是 ${name}）`)
              }
              if (name === '@deepseek-ai/dsh-agent-preset') {
                manifest.hasPreset = true
                const config = node.config && typeof node.config === 'object' ? node.config : {}
                const presetId = asText(config.id)
                if (presetId === '') errors.push(`${where}: agent-preset 缺少 config.id`)
                else if (!NAME_PATTERN.test(presetId)) {
                  errors.push(`${where}: config.id 不合法（${presetId}），须匹配 /^[a-z][a-z0-9-]*$/`)
                } else if (manifest.presetIds.includes(presetId)) {
                  errors.push(`${where}: preset id 重复：${presetId}`)
                } else {
                  manifest.presetIds.push(presetId)
                }
                if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
                  errors.push(`${where}: agent-preset 的 config.plugins 必须是非空数组`)
                } else {
                  config.plugins.forEach((plugin, index) => {
                    if (typeof plugin?.name !== 'string' || plugin.name.trim() === '') {
                      errors.push(`${where}.config.plugins[${index}] 缺少非空 name`)
                    }
                  })
                }
              }
            })
            if (walked.rows === 0) warnings.push('patch 里没有任何行（只有空 insert 也算合法，但装上不会有效果）')
            for (const id of walked.duplicates) warnings.push(`行 id 重复：${id}（加载器可能只认第一条）`)
          }
        }
      }
    }

    // ---- 检查 5：main / exports ----
    /** @type {string[]} */
    const entryFiles = []
    const mainEntry = asText(pkg.main)
    if (mainEntry === '') {
      warnings.push('package.json 没有 main（只有 patch、没有 JS 入口的 bundle 可以接受）')
    } else {
      const mainPath = path.resolve(root, mainEntry)
      if (!fileExists(mainPath)) errors.push(`main 指向的文件不存在：${mainEntry}`)
      else entryFiles.push(mainPath)
    }

    const dotEntry = exportsEntry(pkg.exports, '.')
    if (dotEntry) {
      const dotPath = path.resolve(root, dotEntry)
      if (!fileExists(dotPath)) errors.push(`exports['.'] 指向的文件不存在：${dotEntry}`)
      else if (!entryFiles.includes(dotPath)) entryFiles.push(dotPath)
    } else if (mainEntry !== '') {
      warnings.push("exports 里没有 '.'（老加载器用 main，新解析可能更严格）")
    }

    const client = pkg?.dsh?.client
    manifest.hasClient = Boolean(client && typeof client === 'object')
    const clientEntry = exportsEntry(pkg.exports, './client')
    if (clientEntry) {
      const clientPath = path.resolve(root, clientEntry)
      if (!fileExists(clientPath)) {
        errors.push(`exports['./client'] 指向的文件不存在：${clientEntry}`)
      } else if (/\.(mjs|js|cjs)$/.test(clientEntry)) {
        entryFiles.push(clientPath)
      }
    }

    // ---- 检查 6：node --check ----
    for (const file of entryFiles) {
      const syntax = checkSyntax(file)
      const label = `语法检查 ${toPosixRelative(root, file)}`
      if (!syntax.ok) errors.push(`${label}：${syntax.detail}`)
      else if (syntax.warning) warnings.push(`${label}：${syntax.detail}`)
    }

    // ---- 检查 7：client platform ----
    if (manifest.hasClient) {
      const platform = client?.platform
      if (platform === undefined || platform === null) {
        warnings.push('dsh.client 已声明但没有 platform（Web 端需要 "web"）')
      } else if (platform !== 'web') {
        warnings.push(`dsh.client.platform 不是 'web'（实际：${JSON.stringify(platform)}）`)
      }
    }

    // ---- 检查 8：展示元数据（插件行与详情页在不激活插件时读它们） ----
    const iconEntry = exportsEntry(pkg.exports, './icon')
    if (iconEntry === null) {
      warnings.push("没有 exports['./icon']：插件列表里会显示默认图标")
    } else {
      const iconPath = path.resolve(root, iconEntry)
      if (!fileExists(iconPath)) {
        errors.push(`exports['./icon'] 指向的文件不存在：${iconEntry}`)
      } else {
        const iconBytes = fs.readFileSync(iconPath)
        if (iconBytes.length > 256 * 1024) errors.push(`图标超过 256 KiB（${iconBytes.length} 字节）：${iconEntry}`)
        const isPng = iconBytes[0] === 0x89 && iconBytes[1] === 0x50 && iconBytes[2] === 0x4e && iconBytes[3] === 0x47
        const isSvg = iconBytes.subarray(0, 256).toString('utf8').includes('<svg')
        if (!isPng && !isSvg) errors.push(`图标既不是 PNG 也不是 SVG（改扩展名不算）：${iconEntry}`)
      }
    }
    const localeDir = path.join(root, 'locale')
    if (!dirExists(localeDir)) {
      warnings.push('没有 locale/：插件行会退回 package.json 的 name / description')
    } else {
      for (const file of fs.readdirSync(localeDir).filter(name => name.endsWith('.json')).sort()) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'))?.meta ?? {}
          if (typeof meta.title !== 'string' || meta.title.trim() === '') warnings.push(`locale/${file} 缺 meta.title（会退回包名）`)
          if (typeof meta.description !== 'string' || meta.description.trim() === '') warnings.push(`locale/${file} 缺 meta.description（详情页只剩包名）`)
        } catch (error) {
          warnings.push(`locale/${file} 不是合法 JSON：${errorText(error)}`)
        }
      }
    }

    return { ok: errors.length === 0, errors, warnings, manifest }
  } catch (error) {
    errors.push(`validateBundle 失败：${errorText(error)}`)
    return { ok: false, errors, warnings, manifest }
  }
}

// ---------------------------------------------------------------------------
// smokeTest
// ---------------------------------------------------------------------------

/**
 * 生成冒烟测试 harness 的源码。
 *
 * harness 是一个独立 ESM 文件：`import` 插件入口、用 Proxy 造一个「什么都有」的
 * 桩 ctx、调用 `apply`，最后把结构化结果打印成一行 JSON。父进程只解析最后一行
 * JSON，所以插件自己往 stdout 打日志也不会污染结果。
 * @param {string} entryUrl - 入口文件的 `file://` URL。
 * @returns {string} harness 源码。
 */
function buildHarnessSource(entryUrl) {
  const urlLiteral = JSON.stringify(entryUrl)
  return [
    '// DSH creation-mode smoke harness（进程内生成，跑完即删）。',
    'const WARNINGS = []',
    'const REGISTERED = []',
    'const message = (error) => (error && error.message ? error.message : String(error))',
    'function makeStub(label) {',
    '  const target = function stub() {}',
    '  return new Proxy(target, {',
    '    apply() { return makeStub(label + "()") },',
    '    get(t, key) {',
    '      if (key === "then" || typeof key === "symbol") return undefined',
    '      if (Object.prototype.hasOwnProperty.call(t, key)) return t[key]',
    '      const child = makeStub(label + "." + String(key))',
    '      t[key] = child',
    '      return child',
    '    },',
    '    set(t, key, value) { t[key] = value; return true },',
    '    has() { return true },',
    '  })',
    '}',
    'const noop = () => {}',
    'function withTimeout(promise, ms, label) {',
    '  let timer',
    '  const timeout = new Promise((_, reject) => {',
    '    timer = setTimeout(() => reject(new Error(label + " 超时 " + ms + "ms")), ms)',
    '  })',
    '  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))',
    '}',
    'const ctx = makeStub("ctx")',
    'ctx.logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, child: () => ctx.logger }',
    'ctx.tools = {',
    '  register(definition) {',
    '    const d = definition && typeof definition === "object" ? definition : {}',
    '    REGISTERED.push({',
    '      name: typeof d.name === "string" ? d.name : null,',
    '      hasDescription: typeof d.description === "string",',
    '      hasParameters: Boolean(d.parameters && typeof d.parameters === "object"),',
    '      hasOutputSchema: Boolean(d.output && d.output.schema),',
    '      hasOutputRender: Boolean(d.output && typeof d.output.render === "function"),',
    '      hasExecute: typeof d.execute === "function",',
    '    })',
    '    return noop',
    '  },',
    '  get: () => undefined,',
    '  list: () => REGISTERED.slice(),',
    '}',
    'ctx.effect = (callback) => {',
    '  try {',
    '    const dispose = typeof callback === "function" ? callback() : undefined',
    '    return typeof dispose === "function" ? dispose : noop',
    '  } catch (error) {',
    '    WARNINGS.push("effect 内抛错：" + message(error))',
    '    return noop',
    '  }',
    '}',
    'ctx.on = () => noop',
    'ctx.once = () => noop',
    'ctx.plugin = () => noop',
    'ctx.inject = () => noop',
    'ctx.get = (name) => makeStub("get(" + String(name) + ")")',
    'ctx.systemPrompt = { section: () => noop, add: () => noop }',
    'ctx.commands = { register: () => noop }',
    'const result = { ok: false, loaded: false, name: null, hasApply: false, keys: [], warnings: WARNINGS, registered: REGISTERED, applyErrors: [], error: null }',
    'process.on("unhandledRejection", (error) => { WARNINGS.push("unhandledRejection：" + message(error)) })',
    'try {',
    '  const mod = await import(' + urlLiteral + ')',
    '  result.loaded = true',
    '  result.keys = Object.keys(mod)',
    '  const text = (value) => (typeof value === "string" ? value : null)',
    '  result.name = text(mod.name) || text(mod.default && mod.default.name)',
    '  const applies = []',
    '  if (typeof mod.apply === "function") applies.push(["apply", mod.apply])',
    '  if (mod.default && typeof mod.default.apply === "function") applies.push(["default.apply", mod.default.apply])',
    '  result.hasApply = applies.length > 0',
    '  for (const pair of applies) {',
    '    try {',
    '      await withTimeout(Promise.resolve(pair[1](ctx, {})), 8000, pair[0])',
    '    } catch (error) {',
    '      result.applyErrors.push(pair[0] + "：" + message(error))',
    '    }',
    '  }',
    '  result.ok = result.loaded && Boolean(result.name || result.hasApply) && result.applyErrors.length === 0',
    '} catch (error) {',
    '  result.error = message(error)',
    '}',
    'console.log(JSON.stringify(result))',
    '',
  ].join('\n')
}

/**
 * 冒烟测试：用 node 子进程 + 桩 ctx 真正 `import` 入口并调用 `apply`。
 *
 * 为什么不用本进程动态 import：插件可能读到本进程的真实环境、全局状态或单例服务，
 * 会把宿主搞脏；子进程还带 `timeout` 兜底，插件里死循环/挂起的 Promise 不会挂住调用方。
 * 桩 ctx 的每个未知属性都返回「可调用、可继续取属性」的 Proxy，所以
 * `ctx.tools.register` / `ctx.logger.info` / `ctx.effect(...)` 都不会炸。
 * @param {string} dir - 包目录（入口取自 package.json 的 main / exports['.']）。
 * @param {{ timeoutMs?: number }} [options] - `timeoutMs` 默认 20000。
 * @returns {{ ok: boolean, entry: string | null, exports: { name: string | null, hasApply: boolean }, log: string, warnings: string[], tools: Array<Record<string, unknown>> }}
 *   `log` 是子进程 stdout/stderr 的合并文本，解析失败时它就是唯一线索。
 */
export function smokeTest(dir, { timeoutMs = 20000 } = /** @type {any} */ ({})) {
  const empty = { ok: false, entry: null, exports: { name: null, hasApply: false }, log: '', warnings: [], tools: [] }
  let harnessPath = ''
  try {
    const dirText = asText(dir)
    if (dirText === '') return { ...empty, log: 'dir 必须是非空字符串' }
    const root = path.resolve(dirText)
    if (!dirExists(root)) return { ...empty, log: `目录不存在：${root}` }

    const pkgPath = path.join(root, 'package.json')
    const pkgResult = readJsonFile(pkgPath)
    if (!pkgResult.ok) return { ...empty, log: `package.json 不可读或不是合法 JSON：${pkgResult.error}` }
    const pkg = pkgResult.value ?? {}

    const candidates = [asText(pkg.main), exportsEntry(pkg.exports, '.') ?? '', 'lib/index.mjs']
    /** @type {string | null} */
    let entry = null
    for (const candidate of candidates) {
      if (candidate === '') continue
      const absolute = path.resolve(root, candidate)
      if (!isInside(root, absolute)) continue
      if (fileExists(absolute)) {
        entry = absolute
        break
      }
    }
    if (!entry) {
      return { ...empty, log: `找不到入口文件（试过 main / exports['.'] / lib/index.mjs）：${candidates.filter(Boolean).join(', ')}` }
    }

    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000
    harnessPath = path.join(os.tmpdir(), `dsh-smoke-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`)
    fs.writeFileSync(harnessPath, buildHarnessSource(pathToFileURL(entry).href), 'utf8')

    const run = spawnSync(process.execPath, [harnessPath], {
      encoding: 'utf8',
      timeout: budget,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    const stdout = asText(run.stdout)
    const stderr = asText(run.stderr)
    const log = `${stdout}${stderr === '' ? '' : `\n[stderr]\n${stderr}`}`.trim()

    if (run.error) {
      return { ...empty, entry, log: `${log}\n无法执行 node 子进程：${errorText(run.error)}`.trim() }
    }
    if (run.signal) {
      return { ...empty, entry, log: `${log}\n子进程被杀（signal ${run.signal}），多半是超时或插件挂起`.trim() }
    }

    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    /** @type {Record<string, any> | null} */
    let parsed = null
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const value = JSON.parse(lines[index])
        if (value && typeof value === 'object' && 'ok' in value) {
          parsed = value
          break
        }
      } catch {
        // 不是 JSON 就继续往前找：插件可能自己 print 过东西。
      }
    }
    if (!parsed) return { ...empty, entry, log: `${log}\n无法从 harness 输出里解析出 JSON 结果`.trim() }

    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
    const tools = Array.isArray(parsed.registered) ? parsed.registered : []
    const shape = {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      hasApply: parsed.hasApply === true,
    }
    const applyErrors = Array.isArray(parsed.applyErrors) ? parsed.applyErrors.map(String) : []
    const ok = parsed.ok === true && applyErrors.length === 0 && parsed.error == null

    const summary = [
      `entry: ${toPosixRelative(root, entry)}`,
      `loaded: ${parsed.loaded === true}`,
      `name: ${shape.name ?? '(null)'}`,
      `hasApply: ${shape.hasApply}`,
      `keys: ${Array.isArray(parsed.keys) ? parsed.keys.join(', ') : ''}`,
      `tools: ${tools.map((tool) => String(tool?.name ?? '?')).join(', ') || '(none)'}`,
      ...(parsed.error ? [`import 错误：${String(parsed.error)}`] : []),
      ...applyErrors.map((line) => `apply 错误：${line}`),
      ...warnings.map((line) => `warning：${line}`),
      `result: ${ok ? 'ok' : 'failed'}`,
    ].join('\n')

    return { ok, entry, exports: shape, log: `${summary}\n\n--- harness 输出 ---\n${log}`.trim(), warnings, tools }
  } catch (error) {
    return { ...empty, log: `smokeTest 失败：${errorText(error)}` }
  } finally {
    if (harnessPath !== '') {
      try {
        fs.unlinkSync(harnessPath)
      } catch {
        // 临时文件删不掉不影响结论。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// snapshotProfile / restoreProfile
// ---------------------------------------------------------------------------

/** profile 里需要备份的两个文件（顺序固定）。 */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml']

/** 快照格式标识，restore 时用来拒绝不认识的 JSON。 */
const SNAPSHOT_KIND = 'dsh-evolve-ptc/profile-snapshot'

/**
 * 备份 profile 的 `package.json` + `cordis.patch.yml` 到一个 JSON 快照文件。
 *
 * 快照是**自包含**的：两个文件的全文内嵌在 JSON 里，所以恢复时不依赖任何旁路文件，
 * 也不会因为快照目录被搬动而失效。只读 profile，不写 profile。
 * @param {{ profileDir: string, outDir: string }} options - profile 目录与快照输出目录。
 * @returns {{ ok: boolean, file: string, dir: string, files: string[], errors: string[], warnings: string[] }}
 *   `file` 是快照绝对路径；`files` 是备份到的文件名列表。
 */
export function snapshotProfile({ profileDir, outDir } = /** @type {any} */ ({})) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  try {
    const profileText = asText(profileDir)
    const outText = asText(outDir)
    if (profileText === '') errors.push('profileDir 必须是非空字符串')
    if (outText === '') errors.push('outDir 必须是非空字符串')
    if (errors.length > 0) return { ok: false, file: '', dir: '', files: [], errors, warnings }

    const profileRoot = path.resolve(profileText)
    const outRoot = path.resolve(outText)
    if (!dirExists(profileRoot)) {
      return { ok: false, file: '', dir: outRoot, files: [], errors: [`profile 目录不存在：${profileRoot}`], warnings }
    }

    /** @type {Array<{ name: string, bytes: number, content: string }>} */
    const files = []
    for (const name of PROFILE_FILES) {
      const source = path.resolve(profileRoot, name)
      if (!isInside(profileRoot, source)) {
        errors.push(`拒绝读取越界路径：${name}`)
        continue
      }
      if (!fileExists(source)) {
        if (name === 'package.json') errors.push(`profile 缺少 ${name}，无法作为基线`)
        else warnings.push(`profile 没有 ${name}（跳过）`)
        continue
      }
      const content = fs.readFileSync(source, 'utf8')
      files.push({ name, bytes: Buffer.byteLength(content, 'utf8'), content })
    }
    if (files.length === 0) errors.push('没有备份到任何文件')
    if (errors.length > 0) return { ok: false, file: '', dir: outRoot, files: [], errors, warnings }

    fs.mkdirSync(outRoot, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshotPath = path.resolve(outRoot, `snapshot-${stamp}.json`)
    if (!isInside(outRoot, snapshotPath)) {
      return { ok: false, file: '', dir: outRoot, files: [], errors: ['快照路径越界'], warnings }
    }

    const payload = {
      kind: SNAPSHOT_KIND,
      version: 1,
      createdAt: new Date().toISOString(),
      profileDir: profileRoot,
      files: files.map((file) => ({ name: file.name, bytes: file.bytes, content: file.content })),
    }
    fs.writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

    return { ok: true, file: snapshotPath, dir: outRoot, files: files.map((file) => file.name), errors, warnings }
  } catch (error) {
    errors.push(`snapshotProfile 失败：${errorText(error)}`)
    return { ok: false, file: '', dir: '', files: [], errors, warnings }
  }
}

/**
 * 从快照恢复 profile 文件（rollback 的唯一入口）。
 *
 * 只认 `snapshotProfile` 生成的快照格式；文件名必须是纯文件名（挡住 `../` 与绝对路径），
 * 写入目标必须在 `profileDir` 之内。不做合并、不做猜测：快照里有什么就写回什么。
 * @param {{ profileDir: string, snapshotFile: string }} options - profile 目录与快照文件。
 * @returns {{ ok: boolean, restored: string[], errors: string[], warnings: string[] }}
 *   `restored` 是写回的相对文件名。
 */
export function restoreProfile({ profileDir, snapshotFile } = /** @type {any} */ ({})) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {string[]} */
  const restored = []
  try {
    const profileText = asText(profileDir)
    const snapshotText = asText(snapshotFile)
    if (profileText === '') errors.push('profileDir 必须是非空字符串')
    if (snapshotText === '') errors.push('snapshotFile 必须是非空字符串')
    if (errors.length > 0) return { ok: false, restored, errors, warnings }

    const profileRoot = path.resolve(profileText)
    const snapshotPath = path.resolve(snapshotText)
    if (!dirExists(profileRoot)) errors.push(`profile 目录不存在：${profileRoot}`)
    if (!fileExists(snapshotPath)) errors.push(`快照文件不存在：${snapshotPath}`)
    if (errors.length > 0) return { ok: false, restored, errors, warnings }

    const parsed = readJsonFile(snapshotPath)
    if (!parsed.ok) return { ok: false, restored, errors: [`快照不是合法 JSON：${parsed.error}`], warnings }
    const snapshot = parsed.value ?? {}
    if (snapshot.kind !== SNAPSHOT_KIND) {
      return { ok: false, restored, errors: [`快照格式不认识（kind=${JSON.stringify(snapshot.kind)}）`], warnings }
    }
    if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
      return { ok: false, restored, errors: ['快照里没有文件内容'], warnings }
    }
    if (typeof snapshot.profileDir === 'string' && path.resolve(snapshot.profileDir) !== profileRoot) {
      warnings.push(`快照来自另一个 profile：${snapshot.profileDir}`)
    }

    /** @type {Array<{ name: string, content: string }>} */
    const entries = []
    for (const entry of snapshot.files) {
      const name = asText(entry?.name)
      const content = typeof entry?.content === 'string' ? entry.content : ''
      if (name === '' || content === '') {
        errors.push('快照里有一条记录缺少 name 或 content')
        continue
      }
      if (name !== path.basename(name) || name.includes('..') || path.isAbsolute(name)) {
        errors.push(`快照文件名不安全，拒绝恢复：${name}`)
        continue
      }
      const target = path.resolve(profileRoot, name)
      if (!isInside(profileRoot, target)) {
        errors.push(`恢复路径越界：${name}`)
        continue
      }
      entries.push({ name, content })
    }
    if (errors.length > 0) return { ok: false, restored, errors, warnings }

    for (const entry of entries) {
      fs.mkdirSync(profileRoot, { recursive: true })
      fs.writeFileSync(path.resolve(profileRoot, entry.name), entry.content, 'utf8')
      restored.push(entry.name)
    }

    return { ok: restored.length > 0, restored, errors, warnings }
  } catch (error) {
    errors.push(`restoreProfile 失败：${errorText(error)}`)
    return { ok: false, restored, errors, warnings }
  }
}

// ---------------------------------------------------------------------------
// profileDoctor
// ---------------------------------------------------------------------------

/**
 * 检查一个包是否真的被 profile 装上并挂上了。
 *
 * 七项检查：profile 的 package.json 可读 → 包在 dependencies → 在 `dsh.profile.bundles`
 * → `node_modules/<name>/package.json` 可解析 → 它声明了 `dsh.bundle.patch` → patch 文件
 * 存在且 YAML 可解析 → patch 里每个 insert 行有非空 `name`。只读，不写。
 * @param {{ profileDir: string, packageName: string }} options - profile 目录与包名。
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }>, manifest: Record<string, any> }}
 *   `manifest` 是已安装包的 dsh 段落，便于调用方看版本与入口。
 */
export function profileDoctor({ profileDir, packageName } = /** @type {any} */ ({})) {
  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const checks = []
  /** @type {Record<string, any>} */
  const manifest = {}

  /** 追加一条检查结果。 @param {string} name @param {boolean} ok @param {string} detail @param {boolean} [skipped] @returns {void} */
  const add = (name, ok, detail, skipped = false) => {
    // skipped 单独标出来：不愿把「没验证」伪装成「已验证通过」。
    checks.push(skipped ? { name, ok, detail, skipped: true } : { name, ok, detail })
  }

  try {
    const profileText = asText(profileDir)
    const packageText = asText(packageName)
    if (profileText === '' || packageText === '') {
      add('参数', false, 'profileDir 与 packageName 都必须是非空字符串')
      return { ok: false, checks, manifest }
    }

    const profileRoot = path.resolve(profileText)
    if (!dirExists(profileRoot)) {
      add('profile 目录', false, `不存在：${profileRoot}`)
      return { ok: false, checks, manifest }
    }

    // 1. profile package.json
    const profilePkgPath = path.join(profileRoot, 'package.json')
    const profilePkgResult = readJsonFile(profilePkgPath)
    add('profile package.json', profilePkgResult.ok, profilePkgResult.ok ? profilePkgPath : profilePkgResult.error)
    if (!profilePkgResult.ok) return { ok: false, checks, manifest }
    /** @type {Record<string, any>} */
    const profilePkg = profilePkgResult.value ?? {}

    // 2. dependencies
    const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies']
    /** @type {string | null} */
    let dependencyGroup = null
    for (const group of dependencyGroups) {
      const block = profilePkg[group]
      if (block && typeof block === 'object' && typeof block[packageText] === 'string') {
        dependencyGroup = group
        break
      }
    }
    add(
      '包在 dependencies',
      dependencyGroup !== null,
      dependencyGroup !== null ? `${dependencyGroup}: ${profilePkg[dependencyGroup][packageText]}` : `dependencies/devDependencies/optionalDependencies 里都没有 ${packageText}`,
    )

    // 3. dsh.profile.bundles
    const bundles = profilePkg?.dsh?.profile?.bundles
    const bundleList = Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : []
    const bundleIndex = bundleList.indexOf(packageText)
    add(
      'dsh.profile.bundles 含该包',
      bundleIndex >= 0,
      bundleIndex >= 0 ? `第 ${bundleIndex + 1} 个（共 ${bundleList.length} 个 bundle）` : '数组里没有它，装上也不会加载',
    )

    // 4. 已安装包的 package.json
    const installedDir = path.resolve(profileRoot, 'node_modules', packageText)
    const installedPkgPath = path.join(installedDir, 'package.json')
    const installedResult = readJsonFile(installedPkgPath)
    add(
      'node_modules 可解析',
      installedResult.ok,
      installedResult.ok ? installedPkgPath : `读不到 ${installedPkgPath}：${installedResult.error}`,
    )
    if (!installedResult.ok) return { ok: checks.every((check) => check.ok), checks, manifest }

    /** @type {Record<string, any>} */
    const installed = installedResult.value ?? {}
    manifest.name = typeof installed.name === 'string' ? installed.name : packageText
    manifest.version = typeof installed.version === 'string' ? installed.version : null
    manifest.main = typeof installed.main === 'string' ? installed.main : null
    manifest.dsh = installed.dsh ?? null

    // 5. dsh.bundle.patch 声明
    const patchSpec = installed?.dsh?.bundle?.patch
    const hasPatch = typeof patchSpec === 'string' && patchSpec.trim() !== ''
    add('声明 dsh.bundle.patch', hasPatch, hasPatch ? patchSpec : '没有 dsh.bundle.patch：这个包不会贡献任何 Loader 行')
    manifest.patchPath = null

    if (hasPatch) {
      const patchPath = path.resolve(installedDir, patchSpec)
      manifest.patchPath = patchPath
      // 6. patch 文件存在
      const patchExists = fileExists(patchPath)
      add('patch 文件存在', patchExists, patchExists ? patchPath : `不存在：${patchPath}`)

      if (patchExists) {
        let patchText = ''
        try {
          patchText = fs.readFileSync(patchPath, 'utf8')
        } catch (error) {
          add('patch 可读', false, errorText(error))
        }
        if (patchText !== '') {
          if (!yaml) {
            add('patch YAML 可解析', true, `跳过：${yamlUnavailableReason || 'js-yaml 不可用'}`, true)
            const problems = lintYamlText(patchText)
            add('patch 结构粗检', problems.length === 0, problems.length === 0 ? '通过' : problems.join('；'))
          } else {
            const parsed = parseYaml(patchText)
            const detail = parsed.ok
              ? parsed.degraded
                ? '可解析（含 !!js 宿主表达式，按去标签模式解析）'
                : '可解析'
              : `${parsed.error}`
            add('patch YAML 可解析', parsed.ok === true, detail)

            if (parsed.ok === true) {
              /** @type {string[]} */
              const nameless = []
              const walked = walkPatch(parsed.value, (node, where) => {
                if (typeof node.name !== 'string' || node.name.trim() === '') {
                  if (!isCordisGroup(node)) nameless.push(`${where} 缺少 name`)
                }
              })
              manifest.rowCount = walked.rows
              add(
                'insert 行都有 name',
                nameless.length === 0,
                nameless.length === 0 ? `${walked.rows} 行全部有 name` : nameless.slice(0, 5).join('；'),
              )
            }
          }
        }
      }
    }

    return { ok: checks.every((check) => check.ok), checks, manifest }
  } catch (error) {
    add('profileDoctor', false, errorText(error))
    return { ok: false, checks, manifest }
  }
}

// ---------------------------------------------------------------------------
// listWorkspace
// ---------------------------------------------------------------------------

/**
 * 列出 root 下每个子目录，标出它像不像一个 DSH bundle。
 *
 * 判定标准：目录里有可解析的 `package.json`，且它声明了 `dsh.bundle.patch`。
 * 跳过 `node_modules` 与 `.` 开头的目录（`.git` / `.selftest` 之类不是工作区成员）。
 * @param {string} root - 工作区根目录。
 * @returns {{ ok: boolean, items: Array<{ name: string, dir: string, bundle: boolean, version: string | null, packageName: string | null, patchPath: string | null }>, errors: string[] }}
 *   `items` 按目录名排序。
 */
export function listWorkspace(root) {
  try {
    const rootText = asText(root)
    if (rootText === '') return { ok: false, items: [], errors: ['root 必须是非空字符串'] }
    const base = path.resolve(rootText)
    if (!dirExists(base)) return { ok: false, items: [], errors: [`目录不存在：${base}`] }

    const entries = fs.readdirSync(base, { withFileTypes: true })
    /** @type {Array<{ name: string, dir: string, bundle: boolean, version: string | null, packageName: string | null, patchPath: string | null }>} */
    const items = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const dir = path.resolve(base, entry.name)
      if (!isInside(base, dir)) continue

      const pkgPath = path.join(dir, 'package.json')
      if (!fileExists(pkgPath)) {
        items.push({ name: entry.name, dir, bundle: false, version: null, packageName: null, patchPath: null })
        continue
      }
      const pkgResult = readJsonFile(pkgPath)
      const pkg = pkgResult.ok ? pkgResult.value ?? {} : {}
      const patchSpec = pkg?.dsh?.bundle?.patch
      const hasPatch = typeof patchSpec === 'string' && patchSpec.trim() !== ''
      const patchPath = hasPatch ? path.resolve(dir, patchSpec) : null
      items.push({
        name: entry.name,
        dir,
        bundle: hasPatch && patchPath !== null && fileExists(patchPath),
        version: typeof pkg.version === 'string' ? pkg.version : null,
        packageName: typeof pkg.name === 'string' ? pkg.name : null,
        patchPath,
      })
    }

    items.sort((left, right) => left.name.localeCompare(right.name))
    return { ok: true, items, errors: [] }
  } catch (error) {
    return { ok: false, items: [], errors: [`listWorkspace 失败：${errorText(error)}`] }
  }
}

// ---------------------------------------------------------------------------
// 附加导出：让 agent 运行时能自省模板与依赖状态
// ---------------------------------------------------------------------------

/** 可用模板名（转发自模板库，稳定顺序）。 */
export { TEMPLATE_NAMES, TEMPLATES, toolIdentifier }

/**
 * 报告 YAML 校验能力：装了 js-yaml 才是 `available: true`。
 *
 * 开发期常见的坑是「包声明了 js-yaml 但没跑 npm install」，此时 validateBundle 只能
 * 降级做粗检。调用方可以用这个函数在结果面板里提示用户。
 * @returns {{ available: boolean, reason: string }} 能力状态。
 */
export function yamlCapability() {
  return { available: yaml !== null, reason: yaml === null ? yamlUnavailableReason || 'js-yaml 不可用' : 'ok' }
}
