/**
 * 创造模式（creation mode）的模板库。
 *
 * 本文件只放「纯字符串模板」：不读写磁盘、不抛异常、不做校验。
 * `creation.mjs` 负责校验名字、做路径守卫、真正落盘。
 *
 * 每个模板都是一个纯函数 `({ name, displayName, packageName }) => [{ relativePath, content }]`，
 * 返回的文件列表用于 `scaffold()` 一次性写出，也用于 `planScaffold()` 预算字节数。
 *
 * 三个模板：
 * - `preset`：带一个 DSH agent 预设的插件（同时提供自己的工具行）。
 * - `tool`  ：只往宿主里加一个工具插件行的最小插件。
 * - `bundle`：只有 patch 行、没有 JS 入口的纯 patch bundle。
 *
 * 约定（与 DSH 加载器契约一致，改动前先读 creation.mjs 的 validateBundle）：
 * - `package.json` 的 `type` 必须是 `module`，`dsh.bundle.patch` 指向 `./cordis.patch.yml`；
 * - patch 文件顶层是 YAML 数组，元素是 `{ insert: [...] }` 或带 `id` 的行；
 * - 每一行（`insert` 内、`config` 内嵌套行）都必须有非空字符串 `name`；
 * - `cordis:group` 只能配合 `group: true` 使用。
 */

/** @typedef {{ relativePath: string, content: string }} TemplateFile */
/** @typedef {(args: { name: string, displayName: string, packageName: string }) => TemplateFile[]} TemplateBuilder */

/**
 * 把 kebab-case 包名派生为工具名/标识符片段。
 * @param {string} name - 已校验的 kebab-case 名字（如 `demo-plugin`）。
 * @returns {string} 只含小写字母数字与下划线的片段（如 `demo_plugin`）。
 */
export function toolIdentifier(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    || 'plugin'
}

/**
 * YAML 单引号转义：单引号内的 `'` 写成 `''`。
 * @param {string} value - 任意文本。
 * @returns {string} 可直接放进 `'...'` 的字面量内容（不含外层引号）。
 */
export function yamlQuote(value) {
  return String(value ?? '').replace(/'/g, "''")
}

/**
 * 生成 README 里三段通用说明，避免三个模板各自复制一份。
 * @param {{ displayName: string, packageName: string, kind: string, detail: string }} args
 * @returns {string} Markdown 正文。
 */
function readme({ displayName, packageName, kind, detail }) {
  return [
    `# ${displayName}`,
    '',
    `这是一个 DeepSeek Harness（DSH）**${kind}** 插件包，由创造模式 \`scaffold()\` 生成。`,
    '',
    detail,
    '',
    '## 结构',
    '',
    '```',
    `${packageName}/`,
    '  package.json        # npm 包 + dsh.bundle.patch 声明',
    '  cordis.patch.yml    # Loader patch：插件/预设行从这里插入',
    '  lib/                # 宿主侧 ESM 入口（bundle 模板没有这一层）',
    '  README.md',
    '```',
    '',
    '## 安装',
    '',
    '1. 把本目录以 `file:` 依赖加进目标 profile 的 `package.json`：',
    '',
    '   ```json',
    `   "dependencies": { "${packageName}": "file:C:/absolute/path/to/${packageName}" }`,
    '   ```',
    '',
    '2. 把包名加进同一份 `package.json` 的 `dsh.profile.bundles` 数组，',
    '   顺序决定 patch 层叠的先后。',
    '3. 在 profile 目录执行 `npm install`（或 pnpm），然后重启 DSH。',
    '4. 确认已加载：运行 doctor 检查，看包在 dependencies、bundles 里，',
    '   且它自己的 cordis.patch.yml 可解析。',
    '',
    '## 怎么改',
    '',
    '- **加工具**：在 `lib/index.mjs` 的 `apply()` 里再调一次 `ctx.tools.register(...)`。',
    '  定义形状必须是 `{ name, description, parameters, output: { schema, render }, execute }`：',
    '  `parameters` 是 JSON Schema 对象（不是字段 DSL），`output.schema` 与 `output.render` 必须给，',
    '  否则宿主无法把返回值渲染成消息内容。',
    '- **改 patch**：`cordis.patch.yml` 里的行 id 必须唯一；`name` 是包名或包内子路径，',
    '  同一 patch 内的 `./lib/index.mjs` 以 patch 文件所在目录为基准。',
    '- **加预设**：复制 `@deepseek-ai/dsh-agent-preset` 那一行，改 `config.id`（小写字母数字连字符）、',
    '  `config.name`、`description` 与 `order`，`config.plugins` 里每行都要有 `name`。',
    '',
    '## 自检',
    '',
    '```bash',
    'node --check lib/index.mjs',
    'node --check lib/client.js',
    '```',
    '',
    '工具名用包名派生，避免和宿主/其它插件撞名；改名前先搜一遍 `node_modules`。',
    '',
  ].join('\n')
}

/**
 * 由名字派生稳定色相（0–359），让每个包生成的图标不一样。
 * @param {string} seed - 包名。
 * @returns {number} 色相角。
 */
function hueOf(seed) {
  let hash = 0
  for (const character of String(seed ?? '')) hash = (hash * 31 + character.codePointAt(0)) % 360
  return hash
}

/**
 * 生成纯几何图标（无文字、无字体、无脚本），符合 DSH 插件图标契约：
 * SVG、包内路径、≤256 KiB、明暗主题下都可读。
 * @param {string} seed - 包名，用来取色。
 * @returns {string} SVG 源码。
 */
function iconSvg(seed) {
  const hue = hueOf(seed)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Plugin icon">
  <rect width="128" height="128" rx="28" fill="#0B1220"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M30 92 L52 70 L74 92" stroke="hsl(${hue} 85% 62%)" stroke-width="10"/>
    <path d="M34 70 L52 52 L70 70" stroke="hsl(${(hue + 28) % 360} 80% 66%)" stroke-width="9"/>
    <path d="M40 50 L52 38 L64 50" stroke="hsl(${(hue + 56) % 360} 78% 70%)" stroke-width="8"/>
  </g>
  <circle cx="52" cy="28" r="5" fill="#EBF6FF"/>
</svg>
`
}

/**
 * 展示元数据：插件行与详情页在**不激活插件**的情况下读 `locale/*.json` 的
 * `meta.title` / `meta.description`，以及 `exports['./icon']` 指向的图标。
 * 缺了它们，插件列表里只会显示包名和默认图标。
 * @param {{ displayName: string, description: string, seed: string }} args
 * @returns {TemplateFile[]} 三个文件。
 */
function displayFiles({ displayName, description, seed }) {
  const en = {
    meta: {
      title: displayName,
      description: `${description}。This plugin row is added to DeepSeek Harness: enable it in Plugins, start a new conversation, and verify the capability there.`,
    },
  }
  const zh = {
    meta: {
      title: displayName,
      description: `${description}。这是一个 DeepSeek Harness 插件行：在「插件」里启用后新建对话验证；关闭后它的行与工具一起消失。`,
    },
  }
  return [
    { relativePath: 'locale/en.json', content: `${JSON.stringify(en, null, 2)}\n` },
    { relativePath: 'locale/zh.json', content: `${JSON.stringify(zh, null, 2)}\n` },
    { relativePath: 'assets/icon.svg', content: iconSvg(seed) },
  ]
}

/**
 * 生成 `package.json`。
 * @param {object} args
 * @param {string} args.packageName - npm 包名。
 * @param {string} args.displayName - 人类可读名。
 * @param {string} args.description - 一句话描述。
 * @param {boolean} args.withEntry - 是否有 JS 入口（`bundle` 模板为 false）。
 * @param {boolean} args.withClient - 是否声明浏览器半边。
 * @returns {TemplateFile} 相对路径与内容。
 */
function packageJson({ packageName, displayName, description, withEntry, withClient }) {
  /** @type {Record<string, unknown>} */
  const pkg = {
    name: packageName,
    version: '0.1.0',
    description: `${displayName} — ${description}`,
    type: 'module',
    license: 'MIT',
    engines: {
      node: '>=22.15',
    },
    dsh: {
      manifestVersion: 1,
      bundle: {
        patch: './cordis.patch.yml',
      },
    },
  }

  if (withEntry) {
    pkg.main = 'lib/index.mjs'
    pkg.exports = {
      '.': './lib/index.mjs',
      './package.json': './package.json',
    }
  } else {
    pkg.exports = {
      './package.json': './package.json',
    }
  }

  if (withClient) {
    pkg.dsh.client = { platform: 'web' }
    pkg.exports['./client'] = './lib/client.js'
  }

  // 展示元数据：插件行/详情页在不激活插件时读这两项，缺了只剩包名与默认图标。
  pkg.exports['./icon'] = './assets/icon.svg'
  pkg.exports['./locale/*.json'] = './locale/*.json'

  pkg.files = withEntry
    ? ['cordis.patch.yml', 'lib', 'locale', 'assets', 'README.md']
    : ['cordis.patch.yml', 'locale', 'assets', 'README.md']

  return {
    relativePath: 'package.json',
    content: `${JSON.stringify(pkg, null, 2)}\n`,
  }
}

/**
 * 生成浏览器半边的最小桩。
 *
 * 只声明 `name` / `inject` / `apply` 而不注册任何 slot：这样它能被 Web 端加载，
 * 又不可能因为宿主版本差异而把面板弄坏。真要加 UI 时再往 `apply` 里填。
 * @param {object} args
 * @param {string} args.slug - 工具标识片段。
 * @returns {TemplateFile} 相对路径与内容。
 */
function clientStub({ slug }) {
  return {
    relativePath: 'lib/client.js',
    content: `/**
 * 浏览器半边（可选）。
 *
 * 现在是空实现：加载成功即返回，不注册任何 slot，所以不会影响 Web 面板。
 * 需要真正的 UI 时，在 apply 里用客户端的 ctx（slots / settings / locale）注册。
 */

/** 客户端插件名，必须唯一。 */
export const name = '${slug}-client'

/** 客户端依赖的其它插件名；空数组表示无。 */
export const inject = []

/**
 * 客户端插件入口。
 * @param {unknown} _ctx - 浏览器侧 Cordis 上下文（当前未使用）。
 * @param {unknown} _config - 该行的 config（当前未使用）。
 * @returns {void}
 */
export function apply(_ctx, _config) {
  // 空实现：能加载、能卸载，不挂任何点。
}
`,
  }
}

/**
 * 生成宿主侧最小 Cordis 插件骨架，里面注册一个 `<slug>_ping` 示例工具。
 * @param {object} args
 * @param {string} args.name - 包名（kebab-case），插件名由它派生，必须和 patch 行 id 对得上。
 * @param {string} args.displayName - 人类可读名（写进注释）。
 * @param {string} args.slug - 工具标识片段（下划线形式，给工具名用）。
 * @param {boolean} args.withClient - 是否在注释里提示 client 半边。
 * @returns {TemplateFile} 相对路径与内容。
 */
function entryModule({ name, displayName, slug, withClient }) {
  return {
    relativePath: 'lib/index.mjs',
    content: `/**
 * ${displayName} — 宿主侧 Cordis 插件入口（ESM）。
 *
 * 契约（DSH Loader 读取）：
 * - \`export const name\`  插件名，全局唯一，用包名派生；
 * - \`export const inject\` 依赖的宿主服务名，空数组表示不需要注入；
 * - \`export function apply(ctx, config)\` 装配入口，返回即表示加载完成。
 *
 * 一个异常都不能漏出去：apply 抛错会让整个 session 加载失败，所以每个外部调用
 * 都自己兜住。工具定义的形状必须是
 * \`{ name, description, parameters, output: { schema, render }, execute }\`，
 * 其中 \`parameters\` 是 JSON Schema 对象（不是字段 DSL）。
 */

/** 插件名：用包名派生（与 patch 行 id 一致），避免与宿主或其它插件冲突。 */
export const name = '${name}-tools'

/** 需要注入的宿主服务；这个骨架不需要任何服务。 */
export const inject = []

/**
 * 装配入口。
 * @param {any} ctx - Cordis 上下文（提供 tools / logger 等服务）。
 * @param {any} config - patch 行里的 \`config\` 对象。
 * @returns {void}
 */
export function apply(ctx, config) {
  const log = ctx?.logger?.info ? (message) => ctx.logger.info(message) : () => {}

  // 不同 DSH 版本的宿主能力可能不同：没有 tools 服务时安静跳过，而不是抛异常。
  if (typeof ctx?.tools?.register !== 'function') {
    log('[${slug}] 宿主没有 tools 服务，跳过工具注册')
    return
  }

  // 示例工具：从 patch 行传入的 config.greeting 可以通过，用来确认配置链路通了。
  const greeting = typeof config?.greeting === 'string' ? config.greeting : 'pong'

  ctx.tools.register({
    name: '${slug}_ping',
    description: '示例工具，返回 pong，用来确认 ${slug} 插件已被宿主正确加载。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    /**
     * 工具实现。返回值必须符合上面的 output.schema。
     * @returns {Promise<string>} 固定字符串。
     */
    async execute() {
      return greeting
    },
  })
}
${withClient ? `
/*
 * 浏览器半边是 lib/client.js，由 package.json 的 exports['./client'] 暴露，
 * dsh.client.platform: 'web' 告诉宿主它有 Web 端代码。现在它是空实现。
 */
` : ''}`,
  }
}

/**
 * `preset` 模板：一个既提供工具、又声明一个 agent 预设的插件。
 *
 * patch 里有两条插入行：
 * 1. 工具行 `<slug>-tools` → `./lib/index.mjs`（宿主侧插件本身）；
 * 2. 预设行 `preset-<slug>` → `@deepseek-ai/dsh-agent-preset`，`config.plugins`
 *    里放官方行（persona / time-context / tool-*）。
 *
 * 故意不把 `./lib/index.mjs` 放进 `config.plugins`：预设里的行由 agent-preset
 * 自己解析，相对路径的基准不一定是 patch 文件；工具行放顶层更稳。
 */
const presetTemplate = ({ name, displayName, packageName }) => {
  const slug = toolIdentifier(name)
  const presetId = String(name)
  const description = `${displayName} 提供的 agent 预设`
  const patch = `# ${displayName} — 由创造模式生成。
#
# 顶层两条行：
#   1. ${name}-tools：插件本体（./lib/index.mjs 以本 patch 文件所在目录为基准）；
#   2. preset-${presetId}：一个 agent 预设，装好后在预设选择器里出现。
#
# 每一条插入行都必须有非空字符串 name。改 id 时注意不要和宿主行撞车。
- insert:
    - id: ${name}-tools
      name: './lib/index.mjs'
      config:
        greeting: 'pong'
    - id: preset-${presetId}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: '${yamlQuote(presetId)}'
        name: '${yamlQuote(displayName)}'
        description: '${yamlQuote(description)}'
        order: 100
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 'You are a coding agent powered by the {{model}} model.'
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
`

  return [
    packageJson({
      packageName,
      displayName,
      description: '带 agent 预设的 DSH 插件',
      withEntry: true,
      withClient: true,
    }),
    { relativePath: 'cordis.patch.yml', content: patch },
    entryModule({ name, displayName, slug, withClient: true }),
    clientStub({ slug }),
    ...displayFiles({ displayName, description: '带 agent 预设的 DSH 插件', seed: packageName }),
    {
      relativePath: 'README.md',
      content: readme({
        displayName,
        packageName,
        kind: 'agent 预设',
        detail: [
          '它做两件事：',
          '',
          `1. 注册一个工具 \`${slug}_ping\`；`,
          `2. 声明一个 agent 预设 \`${presetId}\`（显示名 ${displayName}），`,
          '   预设里的 `plugins` 决定这个 agent 能用哪些工具、带什么人格。',
        ].join('\n'),
      }),
    },
  ]
}

/**
 * `tool` 模板：只加一个工具插件行的最小插件。
 *
 * patch 里只有一行 `- id: <name>-tools, name: ./lib/index.mjs`，
 * 装着 `lib/index.mjs` 里的 `<slug>_ping` 工具。
 */
const toolTemplate = ({ name, displayName, packageName }) => {
  const slug = toolIdentifier(name)
  const patch = `# ${displayName} — 由创造模式生成。
#
# 只有一条插入行：插件本体。
# name 是包内相对路径，以本 patch 文件所在目录为基准（即包根）。
# 想让别处也能按包名引用时，把 name 改成包名 ${packageName}，
# 并确保 package.json 的 main/exports 指向 lib/index.mjs。
- insert:
    - id: ${name}-tools
      name: './lib/index.mjs'
      config:
        greeting: 'pong'
`

  return [
    packageJson({
      packageName,
      displayName,
      description: '只提供一个工具的 DSH 插件',
      withEntry: true,
      withClient: true,
    }),
    { relativePath: 'cordis.patch.yml', content: patch },
    entryModule({ name, displayName, slug, withClient: true }),
    clientStub({ slug }),
    ...displayFiles({ displayName, description: '只提供一个工具的 DSH 插件', seed: packageName }),
    {
      relativePath: 'README.md',
      content: readme({
        displayName,
        packageName,
        kind: '工具',
        detail: [
          '它只做一件事：注册一个工具。',
          '',
          `- 工具名：\`${slug}_ping\``,
          '- `parameters` 是空 JSON Schema：这个示例不吃参数；',
          '- `execute()` 返回字符串 `pong`，由 `output.render` 渲染成一条 text。',
        ].join('\n'),
      }),
    },
  ]
}

/**
 * `bundle` 模板：只有 patch 行、没有 JS 入口的纯 patch 包。
 *
 * 适合「只改宿主配置 / 只插官方行」的包：没有 main、没有 lib/，
 * `dsh.bundle.patch` 是它唯一的内容。生成后 patch 里是 `- insert: []` 占位，
 * 注释里写清楚该填什么。
 */
const bundleTemplate = ({ name: _name, displayName, packageName }) => {
  const patch = `# ${displayName} — 由创造模式生成（纯 patch bundle，没有 JS 入口）。
#
# 这个包的全部内容就是这一层 patch。下面是最小骨架：
#
# - insert: 新增 Loader 行。每行都要有唯一 id 和非空 name：
#
#   - insert:
#       - id: my-row
#         name: '@deepseek-ai/dsh-tool-todo'
#         config: {}
#
# - id: <已有行 id>：覆盖/关闭别的 bundle 已经声明的行（不需要 name）：
#
#   - id: tool-todo
#     config:
#       allowParallelInProgress: false
#
# 现在是空数组：不插任何行，装上等于什么都没发生，方便先跑通安装链路。
- insert: []
`

  return [
    packageJson({
      packageName,
      displayName,
      description: '纯 patch bundle（只有 cordis.patch.yml）',
      withEntry: false,
      withClient: false,
    }),
    { relativePath: 'cordis.patch.yml', content: patch },
    ...displayFiles({ displayName, description: '纯 patch bundle（只有 cordis.patch.yml）', seed: packageName }),
    {
      relativePath: 'README.md',
      content: readme({
        displayName,
        packageName,
        kind: '纯 patch bundle',
        detail: [
          '它没有 JS 入口，只有 `cordis.patch.yml` 一层 patch。',
          '',
          '当前 patch 是 `- insert: []` 的空占位：先让安装链路跑通，',
          '再按文件里的注释往里填 `insert` 行或 `id` 覆盖行。',
        ].join('\n'),
      }),
    },
  ]
}

/**
 * 所有可用模板。
 * @type {Record<string, TemplateBuilder>}
 */
export const TEMPLATES = {
  preset: presetTemplate,
  tool: toolTemplate,
  bundle: bundleTemplate,
}

/**
 * 模板名列表（稳定顺序：preset, tool, bundle）。
 * @type {string[]}
 */
export const TEMPLATE_NAMES = ['preset', 'tool', 'bundle']

/**
 * 取模板构建器；名字不合法时返回 `undefined`（不抛异常）。
 * @param {unknown} template - 模板名。
 * @returns {TemplateBuilder | undefined}
 */
export function getTemplate(template) {
  const key = String(template ?? '').trim()
  return Object.prototype.hasOwnProperty.call(TEMPLATES, key) ? TEMPLATES[key] : undefined
}
