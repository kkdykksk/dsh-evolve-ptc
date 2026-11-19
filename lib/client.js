// Evolve PTC 客户端：在 DSH 设置页注册「进化 PTC」分区，并在插件管理页显示同一张设置卡片。
// 外形照 dsh-deep-ptc-mode 的 lib/client.js：window.__ModuleLoader__.load + factory(require)。
window.__ModuleLoader__.load({ id: 'dsh-evolve-ptc', factory: require => {
  const React = require('react');
  const h = React.createElement;
  // 设置表单的命名空间，与 cordis.patch.yml 里那一行的 id 一致，表单由宿主按此 id 提供。
  const NS = 'evolve-ptc-settings';
  // 文案字典的命名空间，供 locale 服务、槽位 label 与 locale/*.json 对应。
  const LOCALE_NS = 'evolve-ptc';
  // 插件 package 名，用作槽位条目的稳定 id 前缀。
  const PLUGIN = 'dsh-evolve-ptc';
  // 设置页分区的短 id，和 deep-ptc 用 'deep-ptc' 的做法一致。
  const SLOT_ID = 'evolve-ptc';
  // 与 deep-ptc 相同：只依赖这三个客户端服务。
  // 只声明真的存在的客户端服务：本构建的客户端服务目录里没有 configForms，
  // 把它写进 inject 会让 apply 永远等不到依赖而静默不执行（槽位一个都不会注册）。
  // 表单服务因此改为按需用 ctx.get('configForms') 取，取不到就走只读展示。
  const inject = ['slots', 'locale'];
  // 配置默认值，与 cordis.patch.yml 的 config 段保持一致。
  const DEFAULTS = {
    environment: 'auto', foregroundSeconds: 30, stallSeconds: 240,
    creationMode: true, rulesInjection: true, maxRules: 8,
  };
  // 两套内联文案；键名与深 PTC 的字典形状对齐（title/summary/save/saving/saved/failed/readOnly/loading）。
  const dictionaries = {
    zh: {
      title: '进化 PTC',
      summary: '执行环境、前台命令转后台阈值、创造模式与自进化规则注入。',
      description: '这些设置写入 Evolve PTC 的插件配置，保存后对之后新建的会话生效。',
      presetName: '进化 PTC 模式',
      presetDescription: '在官方 PTC 之上加入可验证的电脑操作契约、任务台账、自我纠错检测与跨会话规则积累。',
      environment: '执行环境',
      environmentHint: '命令实际使用的 Shell。auto 在 Windows 用 PowerShell，macOS 用 Zsh，其他平台用 Bash。',
      auto: '自动（按当前系统选择）',
      wsl: 'WSL Bash（Windows）',
      powershell: 'PowerShell（Windows）',
      zsh: 'Zsh（macOS / Linux）',
      bash: 'Bash（macOS / Linux；Windows 需自带 bash.exe）',
      foreground: '前台命令转后台阈值',
      foregroundHint: '前台命令超过该秒数会转为后台任务，范围 5–600，默认 30。',
      creationMode: '创造模式',
      creationModeHint: '开启后先脚手架、校验、冒烟测试再安装新插件，失败自动回滚。',
      rulesInjection: '自进化规则注入',
      rulesInjectionHint: '把跨会话积累的规则注入系统提示，让改过的问题不再复发。',
      maxRules: '每次注入的规则上限',
      maxRulesHint: '单次注入的规则条数上限，范围 1–20，默认 8。',
      stallSeconds: '停滞判定秒数',
      stallSecondsHint: '后台任务连续无变化超过该秒数即报告为停滞，最少 60，默认 240。',
      invalid: '有数值不在允许范围内，请先修正。',
      save: '保存', saving: '保存中…', saved: '已保存，之后新建的会话将使用这些设置。',
      failed: '未能保存，请检查数值范围，或设置是否已在其他窗口被修改。',
      readOnly: '当前设置为只读。', loading: '正在读取设置…',
      unavailable: '当前宿主未提供这项设置的配置表单。',
    },
    en: {
      title: 'Evolve PTC',
      summary: 'Execution environment, foreground-to-background threshold, creation mode and rule injection.',
      description: 'These settings write into the Evolve PTC plugin configuration and apply to sessions created afterwards.',
      presetName: 'Evolve PTC Mode',
      presetDescription: 'Adds a verifiable computer-operation contract, a task ledger, self-correcting detectors and cross-session rules on top of official PTC.',
      environment: 'Execution environment',
      environmentHint: 'Shell used for commands. auto picks PowerShell on Windows, Zsh on macOS and Bash elsewhere.',
      auto: 'Automatic (follows the current system)',
      wsl: 'WSL Bash (Windows)',
      powershell: 'PowerShell (Windows)',
      zsh: 'Zsh (macOS / Linux)',
      bash: 'Bash (macOS / Linux; Windows needs bash.exe)',
      foreground: 'Foreground-to-background threshold',
      foregroundHint: 'A foreground command running longer than this moves to a background job. Range 5-600, default 30.',
      creationMode: 'Creation mode',
      creationModeHint: 'Scaffold, validate and smoke-test a new plugin before installing it, then roll back on failure.',
      rulesInjection: 'Rule injection',
      rulesInjectionHint: 'Inject rules accumulated across sessions so a fixed problem does not come back.',
      maxRules: 'Rules injected per turn',
      maxRulesHint: 'Upper bound of injected rules. Range 1-20, default 8.',
      stallSeconds: 'Stalled job threshold',
      stallSecondsHint: 'A background job unchanged this long is reported as stalled. Minimum 60, default 240.',
      invalid: 'A value is outside its allowed range. Fix it before saving.',
      save: 'Save', saving: 'Saving…', saved: 'Saved. Sessions created afterwards will use these settings.',
      failed: 'Could not save. Check the value ranges, or whether the settings changed in another window.',
      readOnly: 'Settings are read-only.', loading: 'Loading settings…',
      unavailable: 'This host does not serve a settings form for this plugin.',
    },
  };
  // 内联样式：只用宿主主题变量，不写死颜色，也不引入 CSS 文件。
  const STYLE = {
    page: { display: 'grid', gap: '12px', maxWidth: '640px' },
    form: { display: 'grid', gap: '12px', maxWidth: '600px' },
    field: { display: 'grid', gap: '4px' },
    label: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, fontSize: '13px' },
    hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: 1.6 },
    note: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: 1.6 },
    error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: 1.6 },
    ok: { margin: 0, color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px', lineHeight: 1.6 },
    control: {
      width: '100%', padding: '8px 10px', borderRadius: '6px', boxSizing: 'border-box',
      font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l1)',
    },
    switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
    switchText: { display: 'grid', gap: '2px' },
    track: {
      position: 'relative', flex: '0 0 auto', width: '40px', height: '22px', padding: 0,
      borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1)',
      transition: 'background-color 120ms ease',
    },
    thumb: {
      position: 'absolute', top: '2px', width: '16px', height: '16px', borderRadius: '50%',
      background: 'var(--dsw-alias-bg-base)', transition: 'left 120ms ease',
    },
    actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    button: {
      justifyContent: 'start', padding: '7px 16px', borderRadius: '6px', font: 'inherit',
      cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
    },
  };
  // 没有订阅可加时的空实现，形状与真订阅的返回值一致。
  const noSubscribe = () => () => {};
  // form 缺失时给 useSyncExternalStore 用的静态快照。
  const NO_FORM = { status: 'unavailable' };
  // 静态快照工厂。
  const noSnapshot = () => NO_FORM;
  // 把 {name} 占位符换成实际值，宿主 locale 是否插值都能得到正确文案。
  const fill = (text, values) => String(text).replace(/\{(\w+)\}/gu,
    (whole, key) => (values[key] === undefined ? whole : String(values[key])));
  // 取一条带占位符的文案并填好。
  const tf = (t, key, values) => fill(t(key, values), values);
  // 页内唯一前缀，避免设置分区与插件条目同时挂载时表单控件 id 冲突。
  let fieldSeq = 0;
  // 生成下一个表单控件前缀。
  const nextFieldPrefix = () => `${SLOT_ID}-${++fieldSeq}`;
  // 把输入框文本解析成整数，非法时回退到默认值。
  function toInt(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(String(raw).trim());
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
  }
  // 判断一个整数是否落在闭区间内。
  function inRange(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
  }
  // 订阅宿主配置表单快照；没有表单时退化为一个不可用的静态快照。
  function useSettingsForm(form) {
    const usable = !!form && typeof form.subscribe === 'function' && typeof form.getSnapshot === 'function';
    const subscribe = React.useCallback(
      listener => { try { return usable ? form.subscribe(listener) : noSubscribe(); } catch { return noSubscribe(); } },
      [form, usable]);
    const read = React.useCallback(
      () => { try { return usable ? form.getSnapshot() : NO_FORM; } catch { return NO_FORM; } },
      [form, usable]);
    return React.useSyncExternalStore(usable ? subscribe : noSubscribe, usable ? read : noSnapshot, usable ? read : noSnapshot);
  }
  // 可选服务一律走 ctx.get：直接读未 inject 的服务在 Cordis 里是抛错。
  function optionalService(ctx, key) {
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get(key) || undefined;
      return ctx ? ctx[key] : undefined;
    } catch {
      return undefined;
    }
  }
  // 从宿主的 configForms 服务里取出本插件行的表单对象，取不到时返回 undefined。
  function readForm(ctx) {
    try {
      const service = optionalService(ctx, 'configForms');
      if (!service || typeof service.get !== 'function') return undefined;
      return service.get(NS) || undefined;
    } catch {
      return undefined;
    }
  }
  // 把一组 { op, path, value } 提交给宿主表单：优先用参考插件的 mutate，其次 update。
  async function applyOps(form, ops, revision) {
    if (form && typeof form.mutate === 'function') return form.mutate(ops, revision);
    if (form && typeof form.update === 'function') return form.update(ops, revision);
    throw new Error('unsupported form api');
  }
  // 一个数字配置项：标签、数字输入框、范围提示与非法值提示。
  function NumberField({ id, label, hint, value, min, max, disabled, bad, badText, onChange }) {
    return h('div', { style: STYLE.field },
      h('label', { htmlFor: id, style: STYLE.label }, label),
      h('input', {
        id, type: 'number', min, max, step: 1, inputMode: 'numeric', value, disabled,
        'aria-invalid': bad ? 'true' : undefined,
        style: bad ? { ...STYLE.control, borderColor: 'var(--dsw-alias-state-error-primary)' } : STYLE.control,
        onChange: event => onChange(event.target.value),
      }),
      h('p', { style: bad ? STYLE.error : STYLE.hint }, bad ? badText : hint));
  }
  // 一个布尔配置项：左侧标题与说明，右侧 role="switch" 的开关。
  function Switch({ id, label, hint, value, disabled, onChange }) {
    const labelId = `${id}-label`;
    return h('div', { style: STYLE.switchRow },
      h('div', { style: STYLE.switchText },
        h('span', { id: labelId, style: STYLE.label }, label),
        h('p', { style: STYLE.hint }, hint)),
      h('button', {
        type: 'button', role: 'switch', 'aria-checked': value ? 'true' : 'false',
        'aria-labelledby': labelId, title: label, disabled,
        onClick: () => { if (!disabled) onChange(!value); },
        style: {
          ...STYLE.track,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          background: value ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)',
        },
      }, h('span', { style: { ...STYLE.thumb, left: value ? '20px' : '2px' }, 'aria-hidden': 'true' })));
  }
  // 设置卡片本体：设置页分区与插件管理页条目共用，view 为 summary 时退化为一行摘要。
  function SettingsCard({ view, form, t }) {
    const state = useSettingsForm(form);
    const prefix = React.useMemo(() => nextFieldPrefix(), []);
    const [environment, setEnvironment] = React.useState(DEFAULTS.environment);
    const [foreground, setForeground] = React.useState(String(DEFAULTS.foregroundSeconds));
    const [stall, setStall] = React.useState(String(DEFAULTS.stallSeconds));
    const [maxRules, setMaxRules] = React.useState(String(DEFAULTS.maxRules));
    const [creationMode, setCreationMode] = React.useState(DEFAULTS.creationMode);
    const [rulesInjection, setRulesInjection] = React.useState(DEFAULTS.rulesInjection);
    const [saving, setSaving] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const [failed, setFailed] = React.useState(false);
    const draftRevision = React.useRef(undefined);
    const dirty = React.useRef(false);
    // 把宿主的当前值灌进草稿，用户改过（dirty）后不再覆盖。
    React.useEffect(() => {
      if (dirty.current) return;
      if (!state || state.status !== 'ready' || !state.value) return;
      const value = state.value;
      setEnvironment(typeof value.environment === 'string' && value.environment ? value.environment : DEFAULTS.environment);
      setForeground(String(toInt(value.foregroundSeconds, DEFAULTS.foregroundSeconds)));
      setStall(String(toInt(value.stallSeconds, DEFAULTS.stallSeconds)));
      setMaxRules(String(toInt(value.maxRules, DEFAULTS.maxRules)));
      setCreationMode(typeof value.creationMode === 'boolean' ? value.creationMode : DEFAULTS.creationMode);
      setRulesInjection(typeof value.rulesInjection === 'boolean' ? value.rulesInjection : DEFAULTS.rulesInjection);
      draftRevision.current = state.revision;
    }, [state.value, state.revision, state.status]);
    // 插件管理页的折叠行只显示一句摘要，其余界面不渲染表单。
    if (view === 'summary') return t('summary');
    // 表单还没就绪：加载中或宿主没有提供表单时给出说明文字。
    if (!state || state.status !== 'ready' || !state.value) {
      return h('p', { style: STYLE.note }, state && state.status === 'unavailable' && !form ? t('unavailable') : t('loading'));
    }
    const writable = state.writable !== false;
    const disabled = !writable || saving;
    const foregroundValue = toInt(foreground, NaN);
    const stallValue = toInt(stall, NaN);
    const maxRulesValue = toInt(maxRules, NaN);
    const badForeground = !inRange(foregroundValue, 5, 600);
    const badStall = !inRange(stallValue, 60, 86400);
    const badMaxRules = !inRange(maxRulesValue, 1, 20);
    const invalid = badForeground || badStall || badMaxRules;
    // 记录首次编辑时的表单版本，保存时用它做乐观并发校验。
    const changed = () => {
      if (!dirty.current) draftRevision.current = state.revision;
      dirty.current = true;
      setMessage('');
      setFailed(false);
    };
    // 把六个配置项一起写回 cordis 配置，并按结果更新保存状态提示。
    async function save(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (!form || invalid || saving) return;
      setSaving(true); setMessage(''); setFailed(false);
      try {
        // 首帧保存时 effect 还没记下版本，回落到当前快照的版本。
        const revision = draftRevision.current === undefined ? state.revision : draftRevision.current;
        const ok = await applyOps(form, [
          { op: 'set', path: ['environment'], value: environment },
          { op: 'set', path: ['foregroundSeconds'], value: foregroundValue },
          { op: 'set', path: ['stallSeconds'], value: stallValue },
          { op: 'set', path: ['creationMode'], value: !!creationMode },
          { op: 'set', path: ['rulesInjection'], value: !!rulesInjection },
          { op: 'set', path: ['maxRules'], value: maxRulesValue },
        ], revision);
        if (!ok) throw new Error('configuration was rejected');
        dirty.current = false;
        const latest = readSnapshot(form);
        draftRevision.current = latest ? latest.revision : undefined;
        if (latest && latest.value) {
          setEnvironment(latest.value.environment || environment);
          setForeground(String(toInt(latest.value.foregroundSeconds, foregroundValue)));
          setStall(String(toInt(latest.value.stallSeconds, stallValue)));
          setMaxRules(String(toInt(latest.value.maxRules, maxRulesValue)));
        }
        setMessage('saved');
      } catch {
        const latest = readSnapshot(form);
        if (latest) draftRevision.current = latest.revision;
        setFailed(true); setMessage('failed');
      } finally {
        setSaving(false);
      }
    }
    return h('form', { onSubmit: save, style: STYLE.form, 'aria-label': t('title') },
      h('p', { style: STYLE.note }, t('description')),
      h('div', { style: STYLE.field },
        h('label', { htmlFor: `${prefix}-environment`, style: STYLE.label }, t('environment')),
        h('select', {
          id: `${prefix}-environment`, value: environment, disabled, style: STYLE.control,
          onChange: event => { changed(); setEnvironment(event.target.value); },
        }, ...['auto', 'wsl', 'powershell', 'zsh', 'bash'].map(value =>
          h('option', { key: value, value }, t(value)))),
        h('p', { style: STYLE.hint }, t('environmentHint'))),
      h(NumberField, {
        id: `${prefix}-foreground`, label: t('foreground'), hint: t('foregroundHint'),
        value: foreground, min: 5, max: 600, disabled, bad: badForeground, badText: t('invalid'),
        onChange: next => { changed(); setForeground(next); },
      }),
      h(Switch, {
        id: `${prefix}-creation`, label: t('creationMode'), hint: t('creationModeHint'),
        value: creationMode, disabled, onChange: next => { changed(); setCreationMode(next); },
      }),
      h(Switch, {
        id: `${prefix}-rules`, label: t('rulesInjection'), hint: t('rulesInjectionHint'),
        value: rulesInjection, disabled, onChange: next => { changed(); setRulesInjection(next); },
      }),
      h(NumberField, {
        id: `${prefix}-max-rules`, label: t('maxRules'), hint: t('maxRulesHint'),
        value: maxRules, min: 1, max: 20, disabled, bad: badMaxRules, badText: t('invalid'),
        onChange: next => { changed(); setMaxRules(next); },
      }),
      h(NumberField, {
        id: `${prefix}-stall`, label: t('stallSeconds'), hint: t('stallSecondsHint'),
        value: stall, min: 60, max: 86400, disabled, bad: badStall, badText: t('invalid'),
        onChange: next => { changed(); setStall(next); },
      }),
      !writable ? h('p', { style: STYLE.note, role: 'status' }, t('readOnly')) : null,
      h('div', { style: STYLE.actions },
        h('button', {
          type: 'submit', disabled: disabled || invalid,
          style: { ...STYLE.button, cursor: disabled || invalid ? 'not-allowed' : 'pointer', opacity: disabled || invalid ? 0.6 : 1 },
        }, t(saving ? 'saving' : 'save')),
        message
          ? h('p', { role: failed ? 'alert' : 'status', style: failed ? STYLE.error : STYLE.ok }, t(message))
          : invalid ? h('p', { style: STYLE.error }, t('invalid')) : null));
  }
  // 读一次表单快照，宿主未提供或不支持时返回 undefined。
  function readSnapshot(form) {
    try { return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined; }
    catch { return undefined; }
  }
  // 设置页分区内容：标题下的说明加设置卡片，没有表单时只显示不可用提示。
  function SettingsPage({ form, t }) {
    return h('section', { style: STYLE.page, 'aria-label': t('title') },
      form ? h(SettingsCard, { form, t }) : h('p', { style: STYLE.note }, t('unavailable')));
  }
  // 设置页导航图标，用 currentColor 跟随主题着色。
  const SettingsIcon = ({ size = 16 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
  },
  h('path', {
    d: 'M8 1.8 9.3 4l2.5.4-1.3 2.2.4 2.5-2.4-.9-2.4.9.4-2.5L5.2 4.4 7.7 4 8 1.8Z',
    stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
  }),
  h('path', { d: 'M3 13.6h10', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }));
  // 注册设置页分区、插件管理页条目与分区图标；任何一个槽缺失都不影响其余注册。
  function apply(ctx) {
    let translate = key => key;
    try { translate = ctx.locale.bind(LOCALE_NS); } catch { /* 语言服务不可用时回落到中文原文 */ }
    // 取一条文案：语言服务异常或缺少键时用中文字典兜底，避免界面出现裸键名。
    const t = (key, values) => {
      let text;
      try { text = typeof translate === 'function' ? translate(key, values) : undefined; } catch { text = undefined; }
      if (typeof text !== 'string' || text === '' || text === key) text = dictionaries.zh[key] || key;
      return values ? fill(text, values) : text;
    };
    // 语言变化时的订阅，供槽位组件重渲染。
    const subscribeLocale = listener => {
      try { return ctx.locale.subscribe(listener) || noSubscribe(); } catch { return noSubscribe(); }
    };
    // 语言快照的版本号，变化即触发重渲染。
    const readLocale = () => {
      try { return (ctx.locale.getSnapshot() || {}).revision || 0; } catch { return 0; }
    };
    // 订阅语言版本，使槽位里的文案跟随 DSH 中英文切换。
    const useLocaleRevision = () => React.useSyncExternalStore(subscribeLocale, readLocale, readLocale);
    // 槽位包装组件：注入当前语言的 t，并在语言切换时重新渲染。
    function LocalizedSlot({ component, ...props }) {
      useLocaleRevision();
      return h(component, { ...props, t: props.t || t });
    }
    // 注册本插件的文案字典，注销时由宿主清理。
    try {
      // 交给 effect 管理注册的存活期，服务缺失时只注册一次。
      const registerLocale = () => ctx.locale.register(LOCALE_NS, dictionaries);
      if (typeof ctx.effect === 'function') ctx.effect(registerLocale, `${PLUGIN}: locale`);
      else registerLocale();
    } catch { /* 字典注册失败时仍用内联兜底文案 */ }
    // 逐个安全注册槽位，把返回的注销函数收进数组。
    function registerAll() {
      const disposers = [];
      // 执行一次注册并收集注销函数；单个槽注册失败就跳过它，不影响其余槽。
      const add = register => {
        try {
          const dispose = register();
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch { /* 这个槽不存在，继续注册其余槽 */ }
      };
      // 设置页里的「进化 PTC」分区。
      add(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: SLOT_ID, order: 25,
        label: () => t('title'), locale: LOCALE_NS,
      }, props => h(LocalizedSlot, { ...props, form: props.form ?? readForm(ctx), component: SettingsPage }))));
      // 插件页里本 bundle 自己的配置卡片：keyed 槽，键就是 bundle 的包名。
      add(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: PLUGIN,
        label: () => t('title'), locale: LOCALE_NS,
      }, props => h(LocalizedSlot, { ...props, form: props.form ?? readForm(ctx), component: SettingsCard }))));
      // 设置页导航图标，缺失时宿主保留默认图标。
      add(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: SLOT_ID,
      }, SettingsIcon)));
      // 注销时反序释放，避免宿主先清父槽再清子槽。
      return () => {
        disposers.reverse().forEach(dispose => { try { dispose(); } catch { /* 已释放 */ } });
      };
    }
    // 表单行被宿主提供期间才注册槽位；没有 whileServed 的宿主直接注册。
    const mountGated = () => {
      const service = optionalService(ctx, 'configForms');
      if (service && typeof service.whileServed === 'function') {
        return service.whileServed([NS], registerAll);
      }
      return registerAll();
    };
    try {
      if (typeof ctx.effect === 'function') ctx.effect(mountGated, `${PLUGIN}: settings slots`);
      else mountGated();
    } catch {
      try { registerAll(); } catch { /* 完全无法注册时保持设置页原样 */ }
    }
  }
  return { apply, inject };
} });
