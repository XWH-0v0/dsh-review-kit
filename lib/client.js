/**
 * Review Kit — Web client half.
 *
 * Registers the row's configuration page on the Plugins page: the keyed
 * `plugins.row.config` slot at `<package>#<row id>`. The page is driven by the
 * Host config form the page owner provides, so it edits the profile's loader-row
 * config through the same path the editor uses — no separate settings store.
 *
 * The artifact is hand-written in the Web module-loader format: a factory that
 * receives the browser module table's `require` and returns a plugin. Keep it
 * free of imports, JSX and side effects outside the factory.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-review-kit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROW_KEY = '@local/dsh-review-kit#review-kit'

    const NUMBER_FIELDS = [
      { key: 'toolBudgetBase', label: '工具预算基数（0 = 各角色用自己的基数）' },
      { key: 'finderToolBudget', label: 'finder 基数（单文件小改动）' },
      { key: 'finderToolBudgetMax', label: 'finder 期望上限' },
      { key: 'verifierToolBudget', label: '复核基数（每条发现）' },
      { key: 'verifierToolBudgetMax', label: '复核期望上限' },
      { key: 'childTimeoutMs', label: '单子代理超时（毫秒）' },
    ]

    const EFFORT_FIELDS = [
      { key: 'finderEffort', label: 'finder 推理强度' },
      { key: 'verifierEffort', label: '复核推理强度' },
    ]

    const EFFORT_OPTIONS = [
      { value: '', label: '继承父代理' },
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ]

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
    const labelStyle = { flex: '1 1 260px', fontSize: '13px' }
    const boxStyle = {
      padding: '4px 8px',
      borderRadius: '6px',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(128,128,128,0.45)',
    }
    const hintStyle = { fontSize: '12px', opacity: 0.72, margin: 0 }

    /**
     * @param {object|null} draft staged edits, or null when nothing is staged.
     * @param {object|undefined} values accepted values from the Host form.
     * @param {string} key field name.
     * @returns {string} the input's text value.
     */
    function numberText(draft, values, key) {
      if (draft !== null && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
      const value = values === undefined ? undefined : values[key]
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    }

    /**
     * @param {object|null} draft staged edits.
     * @param {object|undefined} values accepted values.
     * @param {string} key field name.
     * @returns {string} the select's value.
     */
    function effortText(draft, values, key) {
      if (draft !== null && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
      const value = values === undefined ? undefined : values[key]
      return typeof value === 'string' ? value : ''
    }

    /**
     * The row's configuration page and its summary line.
     * @param {object} props `{ view, form }` from the Plugins page.
     * @returns {object|string} the rendered page, or the summary text.
     */
    function ReviewSettings(props) {
      const view = props === undefined ? 'page' : props.view
      const form = props === undefined ? undefined : props.form
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const revision = form !== undefined && form.state !== undefined ? form.state.revision : undefined
      React.useEffect(() => {
        setDraft(null)
        setBusy(false)
        setMessage('')
      }, [revision])

      if (view === 'summary') return '工具预算基数、推理强度与子代理超时'
      if (form === undefined || form.state === undefined) {
        return h('p', { style: hintStyle }, '这个部署没有把 review-kit 的配置暴露给客户端。')
      }
      const state = form.state
      if (state.status === 'loading') return h('p', { style: hintStyle }, '正在读取配置…')
      if (state.status === 'unavailable' || state.value === undefined) {
        return h('p', { style: hintStyle }, '配置不可编辑：Host 没有暴露这个插件的配置。')
      }
      const values = state.value
      const disabled = state.writable === false || busy

      const stage = (key) => (event) => {
        const next = draft === null ? {} : { ...draft }
        next[key] = event.target.value
        setDraft(next)
        setMessage('')
      }

      const save = async () => {
        if (draft === null || busy) return
        const ops = []
        for (const [key, raw] of Object.entries(draft)) {
          if (raw === '') continue
          const numeric = NUMBER_FIELDS.some((field) => field.key === key)
          const value = numeric ? Number(raw) : raw
          if (numeric && (!Number.isFinite(value) || value < 0)) {
            setMessage(`${key} 不是有效数字，未保存`)
            return
          }
          ops.push({ op: 'set', path: [key], value })
        }
        if (ops.length === 0) return
        setBusy(true)
        setMessage('保存中…')
        try {
          const ok = await form.mutate(ops, state.revision)
          setMessage(ok ? '已保存' : 'Host 未接受这些值，修改已保留')
          if (ok) setDraft(null)
        } catch (error) {
          setMessage(`保存失败：${error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const rows = []
      for (const field of NUMBER_FIELDS) {
        rows.push(h('label', { key: field.key, style: rowStyle },
          h('span', { style: labelStyle }, field.label),
          h('input', {
            type: 'number',
            min: 0,
            step: 1,
            disabled,
            style: { ...boxStyle, width: '110px' },
            value: numberText(draft, values, field.key),
            onChange: stage(field.key),
          })))
      }
      for (const field of EFFORT_FIELDS) {
        rows.push(h('label', { key: field.key, style: rowStyle },
          h('span', { style: labelStyle }, field.label),
          h('select', {
            disabled,
            style: { ...boxStyle, width: '150px' },
            value: effortText(draft, values, field.key),
            onChange: stage(field.key),
          }, ...EFFORT_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))))
      }
      if (state.writable === false) {
        rows.push(h('p', { key: 'readonly', style: hintStyle }, '这个部署以只读方式保存设置。'))
      }
      rows.push(h('div', { key: 'actions', style: rowStyle },
        h('button', {
          type: 'button',
          disabled: disabled || draft === null,
          style: { ...boxStyle, width: 'auto', cursor: 'pointer', opacity: draft === null ? 0.6 : 1 },
          onClick: () => { void save() },
        }, busy ? '保存中…' : '保存'),
        message !== '' ? h('span', { style: hintStyle }, message) : null))
      rows.push(h('p', { key: 'hint', style: hintStyle },
        '工具预算基数只改起点：实际期望值按改动文件数与改动文本量放大，并允许轻微超出。'))
      return h('div', { style: { display: 'grid', gap: '10px', minWidth: 0 } }, ...rows)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
        }, ReviewSettings))
      },
    }
  },
})
