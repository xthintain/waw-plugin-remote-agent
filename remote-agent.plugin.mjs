/**
 * remote-agent — dual-runtime desktop plugin (TUI parity probe).
 *
 * Same file, two evaluations:
 *   · tui-host  → api.capabilities.tools|modules|servers  (callable tools)
 *   · browser   → api.capabilities.ui|extras              (panel / settings / commands)
 *
 * Creating a remote project and browsing its directories live here.
 * The kernel half spawns waw-remote-agent (SSH only to launch the binary) and
 * routes shell/fs tools over its RPC.
 *
 * SSH config / key discovery + passphrase form live in THIS plugin's settings
 * UI (settingsSection.render) — not a built-in Settings nav item.
 */

import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  assertModeAllowsTarget,
  getAgentMode,
  isTargetAllowedInMode,
  normalizeAgentMode,
  setAgentModeRaw,
  subscribeAgentMode,
} from './remote-mode.mjs'

const COLORS = {
  accent: '#2F6FED',
  ink: '#1a1f2c',
  dim: '#6b7280',
  warn: '#b42318',
  ok: '#067647',
  line: '#e5e7eb',
  soft: '#f8fafc',
}

const UI_ID = 'remote-agent.panel'
const ACTION_ID = 'remote-agent.action'
const CREATE_ID = 'remote-agent.create'
const STORE_TARGETS = 'waw:plugin:remote-agent:targets'
const STORE_MODE = 'waw:plugin:remote-agent:mode'
const SETTINGS_ID = 'remote-agent'
const DAEMON_ACTIONS = ['status', 'stop', 'start', 'restart']
const MODE_ACTIONS = ['status', 'switch']

const AUTH_KINDS = [
  { value: 'local', label: '本机管道' },
  { value: 'agentWs', label: '预装 Agent（WS 逆向）' },
  { value: 'sshConfig', label: 'SSH config Host' },
  { value: 'privateKey', label: '主机 + 私钥' },
]

const BG_DATA_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#dbeafe"/><stop offset="100%" stop-color="#e0e7ff"/>
      </linearGradient></defs>
      <rect width="800" height="600" fill="url(#g)"/>
    </svg>`,
  )

function capsOf(api) {
  return (
    api.capabilities ?? {
      tools: false,
      modules: false,
      servers: false,
      ui: true,
      extras: true,
    }
  )
}

function loadTargets() {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORE_TARGETS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveTargets(rows) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORE_TARGETS, JSON.stringify(rows))
  } catch {
    /* privacy mode */
  }
}

function loadStoredMode() {
  try {
    if (typeof localStorage === 'undefined') return getAgentMode()
    const raw = localStorage.getItem(STORE_MODE)
    const normalized = normalizeAgentMode(raw)
    if (normalized) {
      setAgentModeRaw(normalized)
      return normalized
    }
    return getAgentMode()
  } catch {
    return getAgentMode()
  }
}

function saveStoredMode(mode) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORE_MODE, mode)
  } catch {
    /* privacy mode */
  }
}

function readPluginSettings() {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(`waw:plugin:settings:${SETTINGS_ID}`)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function uid() {
  return `ra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** WS dial / 工作区路径校验，错误要写清原因与改法。 */
function explainDialWs(raw) {
  const location = String(raw ?? '').trim()
  if (!location) {
    return { ok: false, error: '请填写 dial-ws，例如 ws://127.0.0.1:3001/remote-agent' }
  }
  let url
  try {
    url = new URL(location)
  } catch {
    return {
      ok: false,
      error: `无法解析为 URL：「${location}」。须为 ws:// 或 wss://，例如 ws://127.0.0.1:3001/remote-agent`,
    }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      ok: false,
      error: `协议是「${url.protocol}」，逆向连接只接受 ws: 或 wss:。若写成 http(s):// 请改成 ws(s)://。`,
    }
  }
  if (!url.hostname) {
    return { ok: false, error: '缺少主机名。例：ws://127.0.0.1:3001/remote-agent' }
  }
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path === '/') {
    return {
      ok: false,
      error: `只写到主机根路径不够。请带上 /remote-agent，例如 ws://${url.host}/remote-agent`,
    }
  }
  if (path !== '/remote-agent') {
    return {
      ok: false,
      error: `路径是「${url.pathname}」，控制面入口应为 /remote-agent。完整示例：ws://${url.host}/remote-agent`,
    }
  }
  return { ok: true, location: url.toString().replace(/\/+$/, '') }
}

function explainWorkspacePath(raw) {
  const location = String(raw ?? '').trim()
  if (!location) {
    return { ok: false, error: '请选择或填写远端工作区绝对路径，例如 /data/ws' }
  }
  if (!location.startsWith('/')) {
    return {
      ok: false,
      error: `工作区「${location}」不是绝对路径。请用 / 开头的目录（可用「浏览」像文件管理器那样选）。`,
    }
  }
  if (location.includes('://')) {
    return {
      ok: false,
      error: `工作区应是文件系统路径，不要写 URL。当前「${location}」像连接串——若要用逆向 WS，请把鉴权改成「预装 Agent（WS 逆向）」。`,
    }
  }
  return { ok: true, location }
}

export default async function remoteAgent(api) {
  const caps = capsOf(api)
  const teardowns = []

  // ── Kernel half (tui-host) ────────────────────────────────────────────────
  if (caps.tools) {
    const bridgeHref = new URL('./remote-bridge.mjs', import.meta.url).href
    const { getAgentModeStatus, switchAgentMode } = await import(/* @vite-ignore */ bridgeHref)
    api.tools.register(
      {
        name: 'remote::ping',
        description: 'Desktop remote-agent probe — confirms plugin tools are live on host.',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string' } },
        },
      },
      (args) =>
        JSON.stringify({
          ok: true,
          plugin: api.name,
          mode: getAgentMode(),
          agentId: typeof args.agentId === 'string' ? args.agentId : null,
          at: new Date().toISOString(),
        }),
    )
    api.tools.register(
      {
        name: 'remote::mode',
        description:
          'Inspect or switch isolated execution mode between remote (SSH) and local (local pipe). The two modes are strictly isolated and cannot run simultaneously.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: MODE_ACTIONS },
            mode: { type: 'string', enum: [...AGENT_MODES] },
          },
        },
      },
      async (args) => {
        const action = String(args?.action ?? (args?.mode ? 'switch' : 'status')).trim()
        if (!MODE_ACTIONS.includes(action)) {
          throw new Error(`action must be ${MODE_ACTIONS.join('|')}`)
        }
        if (action === 'status') {
          const status = getAgentModeStatus()
          return JSON.stringify({
            ok: true,
            ...status,
            isolatedFrom: status.mode === 'local' ? 'remote' : 'local',
          })
        }
        const nextMode = normalizeAgentMode(args?.mode)
        if (!nextMode) {
          throw new Error(`mode must be ${AGENT_MODES.join('|')}`)
        }
        const result = await switchAgentMode(nextMode)
        return JSON.stringify({
          ok: true,
          ...result,
          isolatedFrom: result.mode === 'local' ? 'remote' : 'local',
        })
      },
    )
    api.tools.register(
      {
        name: 'remote::daemon',
        description: 'Mock of misc::remote_agent_daemon (status|stop|start|restart).',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            action: { type: 'string', enum: DAEMON_ACTIONS },
          },
          required: ['agentId', 'action'],
        },
      },
      (args) => {
        const agentId = String(args.agentId ?? '').trim()
        const action = String(args.action ?? '').trim()
        if (!agentId) throw new Error('agentId required')
        if (!DAEMON_ACTIONS.includes(action)) {
          throw new Error(`action must be ${DAEMON_ACTIONS.join('|')}`)
        }
        return JSON.stringify({
          agentId,
          daemon: `${agentId}:daemon`,
          method: `daemon_${action}`,
          result: {
            mock: true,
            worker: { state: action === 'stop' ? 'stopped' : 'running', pid: 0 },
          },
        })
      },
    )
    teardowns.push(() => {
      for (const name of api.tools.names()) api.tools.unregister(name)
    })
  }

  if (caps.modules) {
    const href = new URL('./remote-exec.mjs', import.meta.url).href
    const { createRemoteProvider, disposeRemoteExec } = await import(/* @vite-ignore */ href)
    // The router and the adapter table live in the kernel now; this plugin only
    // supplies the SSH transport. Installing it through the `remote` module
    // keeps the two halves of "remote" switchable together.
    const remoteModule = api.modules.get('remote')
    if (!remoteModule?.routing) {
      throw new Error('remote module is not loaded; cannot install the SSH transport')
    }
    teardowns.push(remoteModule.routing.install(createRemoteProvider()))
    teardowns.push(disposeRemoteExec)
  }

  // ── UI / extras half (browser) ────────────────────────────────────────────
  if (!caps.ui && !caps.extras) {
    return () => {
      for (const fn of teardowns) fn()
    }
  }

  const { Box, Text, h, useState, useEffect } = api.ui
  let targets = loadTargets()
  let activeMode = loadStoredMode()
  let lastDaemon = null
  const listeners = new Set()
  const notify = () => {
    for (const fn of listeners) fn()
  }

  function remountPanel() {
    try {
      api.unmount(UI_ID)
    } catch {
      /* first mount */
    }
    api.mount({
      uiId: UI_ID,
      plugin: api.name,
      title: 'Remote Agent',
      slot: 'panel',
      edge: 'left',
      key: 'ctrl+alt+r',
      render: (ctx) => h(Panel, { ctx }),
      lifecycle: 'active',
      pids: [],
      open: true,
    })
    api.status(UI_ID, 'active')
  }

  function openCreate() {
    // Prefer the desktop React dialog (DSH-style host → workspace → create).
    // Fall back to the in-plugin overlay only if the host shell is missing.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('waw-desktop-dialog', { detail: { dialog: 'remote' } }))
      return
    }
    api.mount({
      uiId: CREATE_ID,
      plugin: api.name,
      title: '创建远程项目',
      slot: 'overlay',
      render: (ctx) => h(Panel, { ctx }),
      lifecycle: 'active',
      pids: [],
      open: true,
    })
  }

  if (caps.ui) {
    api.mount({
      uiId: ACTION_ID,
      plugin: api.name,
      title: '远程',
      slot: 'action',
      render: () =>
        h(
          'button',
          {
            type: 'button',
            title: '远程项目',
            'aria-label': '远程项目',
            onClick: () => openCreate(),
          },
          h(
            'svg',
            {
              width: 18,
              height: 18,
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              'aria-hidden': true,
            },
            h('rect', { x: 1, y: 4.2, width: 7, height: 5.6, rx: 1 }),
            h('path', { d: 'M10.2 5.4a2.8 2.8 0 0 1 0 5.2M12.5 3.4a5.6 5.6 0 0 1 0 9.2' }),
          ),
        ),
      lifecycle: 'active',
      pids: [],
      open: true,
    })
  }

  if (caps.extras && typeof api.command === 'function') {
    api.command({
      id: 'remote-agent.show-panel',
      label: 'Remote Agent：目标面板（按需）',
      group: '插件',
      keys: 'Ctrl+Alt+R',
      run: () => remountPanel(),
    })
    api.command({
      id: 'remote-agent.switch-mode',
      label: 'Remote Agent：切换 Remote / Local 隔离模式',
      group: '插件',
      run: () => {
        const next = activeMode === 'local' ? 'remote' : 'local'
        setAgentModeRaw(next)
        activeMode = next
        saveStoredMode(next)
        notify()
      },
    })
    api.command({
      id: 'remote-agent.clear-targets',
      label: 'Remote Agent：清空目标',
      group: '插件',
      run: () => {
        targets = []
        saveTargets(targets)
        notify()
      },
    })
  }

  let FolderBrowser = null
  let ThemeSelect = null
  if (caps.ui || caps.extras) {
    // App-relative imports only work for the Vite-bundled UI half.
    try {
      FolderBrowser = (await import('../components/FolderBrowser')).FolderBrowser
      ThemeSelect = (await import('../components/settings/ThemeSelect')).ThemeSelect
    } catch {
      FolderBrowser = null
      ThemeSelect = null
    }
  }

  if (caps.extras && typeof api.settingsSection === 'function') {
    const [{ SshRemotePanel }, { ensureSshDiscover }] = await Promise.all([
      import('../components/settings/SshRemotePanel'),
      import('../settings/ssh-remote'),
    ])
    void ensureSshDiscover()
    const { h } = api.ui
    api.settingsSection({
      title: '远程设备',
      fields: [],
      render: () => h(SshRemotePanel),
    })
  }

  if (caps.extras && api.backgrounds?.add) {
    api.backgrounds.add([
      { id: 'remote-haze', label: 'Remote haze', url: BG_DATA_URL, fit: 'cover' },
    ])
  }

  function applySettingsSideEffects() {
    const s = readPluginSettings()
    if (s.useBackground === true && api.backgrounds?.set) {
      const cur = api.backgrounds.current?.() ?? null
      api.backgrounds.set({
        pluginId: api.name,
        imageId: 'remote-haze',
        scrim: cur?.scrim ?? 'mid',
      })
    }
  }

  function Panel({ ctx }) {
    const [, tick] = useState(0)
    const [name, setName] = useState('本机远端')
    const [mode, setMode] = useState(() => activeMode)
    const [authKind, setAuthKind] = useState(() => {
      if (activeMode === 'local') return 'local'
      const s = readPluginSettings()
      const candidate = typeof s.defaultAuth === 'string' ? s.defaultAuth : 'sshConfig'
      return candidate === 'local' ? 'sshConfig' : candidate
    })
    const [agentId, setAgentId] = useState('pod-a')
    const [host, setHost] = useState('')
    const [remoteRoot, setRemoteRoot] = useState(() => {
      const s = readPluginSettings()
      return typeof s.defaultRemoteRoot === 'string' && s.defaultRemoteRoot
        ? s.defaultRemoteRoot
        : '/tmp/waw-remote-ws'
    })
    const [dialWs, setDialWs] = useState(() => {
      const s = readPluginSettings()
      return typeof s.defaultDialWs === 'string' && s.defaultDialWs
        ? s.defaultDialWs
        : 'ws://127.0.0.1:3001/remote-agent'
    })
    const [err, setErr] = useState(null)
    const [busy, setBusy] = useState(false)
    const [browsing, setBrowsing] = useState(false)

    useEffect(() => {
      const fn = () => {
        setMode(activeMode)
        tick((n) => n + 1)
      }
      listeners.add(fn)
      const unsubMode = subscribeAgentMode((ev) => {
        activeMode = ev.mode
        setMode(ev.mode)
        setAuthKind((prev) => {
          if (ev.mode === 'local') return 'local'
          return prev === 'local' ? 'sshConfig' : prev
        })
      })
      applySettingsSideEffects()
      return () => {
        listeners.delete(fn)
        unsubMode()
      }
    }, [])

    function switchUiMode(nextMode) {
      const normalized = normalizeAgentMode(nextMode)
      if (!normalized || normalized === mode) return
      setAgentModeRaw(normalized)
      activeMode = normalized
      saveStoredMode(normalized)
      setMode(normalized)
      setAuthKind(normalized === 'local' ? 'local' : 'sshConfig')
      setErr(null)
      notify()
    }

    const settings = readPluginSettings()
    const mockOnline = settings.mockOnline !== false
    const pathLikeBrowse =
      authKind === 'local' || authKind === 'sshConfig' || authKind === 'privateKey'

    async function browseWorkspace() {
      setErr(null)
      try {
        assertModeAllowsTarget({ authKind }, mode)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return
      }
      if (authKind === 'local' || authKind === 'sshConfig') {
        if (authKind === 'sshConfig' && !host.trim()) {
          setErr('请先填写 SSH config 里的 Host 名，再浏览那台机器上的目录')
          return
        }
        setBrowsing(true)
        return
      }
      setErr('私钥主机请手填远端绝对路径。要浏览目录，请改用「SSH config Host」。')
    }

    async function publishProject(row) {
      if (row.authKind !== 'sshConfig' || !row.host) return
      const location = `ssh://${row.host}${row.remoteWorkspaceRoot}`
      const project = {
        id: row.id,
        name: row.name,
        kind: 'remote',
        location,
        pinned: false,
        archived: false,
        createdAt: Date.now(),
      }
      // 只登记项目。工作区在每个会话发送时按 sessionId 绑定（store/api.ts），
      // 这里再写一次全局会越过会话边界。
      const [{ tuiUpsertProject }] = await Promise.all([import('../agent/tui-host-api')])
      await tuiUpsertProject(project)
      window.dispatchEvent(new CustomEvent('waw-desktop-project', { detail: project }))
    }

    async function addTarget() {
      setBusy(true)
      setErr(null)
      try {
        try {
          assertModeAllowsTarget({ authKind }, mode)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
          return
        }
        if (authKind === 'agentWs' && !agentId.trim()) {
          setErr('agentWs 需要 agentId（与远端 --agent-id 一致，例如 pod-a）')
          return
        }
        let resolvedDial = undefined
        if (authKind === 'agentWs') {
          const dial = explainDialWs(dialWs)
          if (!dial.ok) {
            setErr(dial.error)
            return
          }
          resolvedDial = dial.location
        }
        const pathCheck = explainWorkspacePath(remoteRoot)
        if (!pathCheck.ok) {
          setErr(pathCheck.error)
          return
        }
        if ((authKind === 'privateKey' || authKind === 'sshConfig') && !host.trim()) {
          setErr(
            authKind === 'sshConfig'
              ? '请填写 SSH config 里的 Host 名'
              : '请填写主机（user@host 或 hostname）',
          )
          return
        }
        const row = {
          id: uid(),
          name: name.trim() || 'remote',
          authKind,
          remoteWorkspaceRoot: pathCheck.location,
          agentId: authKind === 'agentWs' ? agentId.trim() : undefined,
          host: authKind === 'privateKey' || authKind === 'sshConfig' ? host.trim() : undefined,
          dialWs: resolvedDial,
          status: mockOnline ? 'online' : 'offline',
          createdAt: new Date().toISOString(),
        }
        targets = [row, ...targets]
        saveTargets(targets)
        notify()
        await publishProject(row)
      } finally {
        setBusy(false)
      }
    }

    function removeTarget(id) {
      targets = targets.filter((r) => r.id !== id)
      saveTargets(targets)
      notify()
    }

    function mockDaemon(row, action) {
      try {
        assertModeAllowsTarget(row, mode)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return
      }
      lastDaemon = {
        at: new Date().toISOString(),
        agentId: row.agentId || row.id,
        action,
        result: {
          mock: true,
          dialWs: row.dialWs || dialWs,
          worker: {
            state: action === 'stop' ? 'stopped' : 'running',
            pid: Math.floor(Math.random() * 9000) + 1000,
          },
        },
      }
      if (action === 'stop') {
        targets = targets.map((t) => (t.id === row.id ? { ...t, status: 'offline' } : t))
      } else if (action === 'start' || action === 'restart') {
        targets = targets.map((t) => (t.id === row.id ? { ...t, status: 'online' } : t))
      }
      saveTargets(targets)
      notify()
    }

    if (browsing && FolderBrowser) {
      return h(FolderBrowser, {
        sshHost: authKind === 'sshConfig' ? host.trim() : undefined,
        initialPath: remoteRoot.startsWith('/') ? remoteRoot : '',
        onCancel: () => setBrowsing(false),
        onSelect: (selected) => {
          setRemoteRoot(selected)
          setBrowsing(false)
          setErr(null)
        },
      })
    }

    const field = (label, child) =>
      h(Box, { marginBottom: 6 }, h(Text, { color: COLORS.dim }, label), child)

    const input = (value, onChange, placeholder) =>
      h('input', {
        value,
        placeholder,
        onChange: (e) => onChange(e.target.value),
        style: {
          display: 'block',
          width: '100%',
          marginTop: 2,
          padding: '4px 6px',
          border: `1px solid ${COLORS.line}`,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'ui-monospace, monospace',
          background: '#fff',
          color: COLORS.ink,
        },
      })

    const btn = (label, onClick, opts = {}) =>
      h(
        'button',
        {
          type: 'button',
          disabled: opts.disabled || busy,
          onClick,
          style: {
            marginRight: 6,
            marginTop: 4,
            padding: '3px 8px',
            fontSize: 11,
            borderRadius: 4,
            border: `1px solid ${opts.danger ? '#fecdca' : COLORS.line}`,
            background: opts.danger ? '#fef3f2' : opts.primary ? COLORS.accent : '#fff',
            color: opts.danger ? COLORS.warn : opts.primary ? '#fff' : COLORS.ink,
            cursor: 'pointer',
          },
        },
        label,
      )

    return h(
      Box,
      {
        flexDirection: 'column',
        padding: 10,
        background: COLORS.soft,
        border: `1px solid ${COLORS.line}`,
        borderRadius: 8,
        height: '100%',
      },
      h(
        Box,
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        h(
          Box,
          { flexDirection: 'row', alignItems: 'center' },
          h(Text, { color: COLORS.accent, bold: true }, 'Remote Agent'),
          h(Text, { color: COLORS.dim }, `  [${ctx.lifecycle}]`),
        ),
        h(
          'button',
          {
            type: 'button',
            title: '关闭面板',
            onClick: () => ctx.close(),
            style: {
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: COLORS.dim,
              fontSize: 16,
              lineHeight: 1,
            },
          },
          '×',
        ),
      ),
      h(
        Text,
        { color: COLORS.dim },
        '同一插件：host 注册 remote::ping / remote::daemon，此处是 UI 半',
      ),
      h(Box, { marginTop: 8 }, h(Text, { color: COLORS.ink, bold: true }, '本进程 capabilities')),
      h(
        Text,
        { color: COLORS.ok },
        `ui=${caps.ui} extras=${caps.extras} tools=${caps.tools} modules=${caps.modules}`,
      ),

      h(
        Box,
        { marginTop: 10 },
        h(Text, { color: COLORS.ink, bold: true }, `运行模式（互斥隔离）：${mode === 'local' ? 'Local Agent' : 'Remote Agent'}`),
        h(
          Box,
          { flexDirection: 'row', marginTop: 4 },
          btn('Remote 模式', () => switchUiMode('remote'), { primary: mode === 'remote' }),
          btn('Local 模式', () => switchUiMode('local'), { primary: mode === 'local' }),
        ),
        h(
          Text,
          { color: COLORS.dim },
          mode === 'local'
            ? '当前仅允许本地执行（本机管道），远端 SSH 目标已隔离。'
            : '当前仅允许远端目标（SSH / WS），本地执行已隔离。',
        ),
      ),

      h(Box, { marginTop: 12 }, h(Text, { color: COLORS.ink, bold: true }, '新建目标')),
      field('名称', input(name, setName, '本机远端')),
      field(
        '鉴权',
        ThemeSelect
          ? h(ThemeSelect, {
              value: authKind,
              options: AUTH_KINDS.filter((k) => isTargetAllowedInMode({ authKind: k.value }, mode)),
              ariaLabel: '鉴权方式',
              onChange: setAuthKind,
            })
          : h(
              Text,
              { color: COLORS.dim },
              AUTH_KINDS.find((k) => k.value === authKind)?.label ?? authKind,
            ),
      ),
      authKind === 'agentWs' ? field('agentId', input(agentId, setAgentId, 'pod-a')) : null,
      authKind === 'agentWs'
        ? field('dial-ws', input(dialWs, setDialWs, 'ws://127.0.0.1:3001/remote-agent'))
        : null,
      authKind === 'privateKey' || authKind === 'sshConfig'
        ? field(authKind === 'sshConfig' ? 'SSH Host' : '主机', input(host, setHost, 'example.com'))
        : null,
      field(
        '远端工作区根',
        h(
          'div',
          { style: { display: 'flex', gap: 6, marginTop: 2, alignItems: 'stretch' } },
          h('input', {
            value: remoteRoot,
            placeholder: '/tmp/waw-remote-ws',
            onChange: (e) => setRemoteRoot(e.target.value),
            style: {
              flex: 1,
              minWidth: 0,
              padding: '4px 6px',
              border: `1px solid ${COLORS.line}`,
              borderRadius: 4,
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
              background: '#fff',
              color: COLORS.ink,
            },
          }),
          pathLikeBrowse
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void browseWorkspace(),
                  title: '像文件管理器一样选择目录',
                  style: {
                    flex: 'none',
                    padding: '3px 10px',
                    fontSize: 11,
                    borderRadius: 4,
                    border: `1px solid ${COLORS.line}`,
                    background: '#fff',
                    color: COLORS.ink,
                    cursor: 'pointer',
                  },
                },
                '浏览',
              )
            : null,
        ),
      ),
      authKind === 'sshConfig'
        ? h(Text, { color: COLORS.dim }, '浏览的是 SSH 主机上的目录，添加后会话在该远程目录执行')
        : h(Text, { color: COLORS.dim }, '本机管道才用本机文件夹；私钥主机请手填远端绝对路径'),
      err
        ? h(
            'p',
            {
              role: 'alert',
              style: {
                margin: '6px 0 0',
                color: COLORS.warn,
                fontSize: 12,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
              },
            },
            err,
          )
        : null,
      btn('添加', addTarget, { primary: true, disabled: busy }),

      h(
        Box,
        { marginTop: 14 },
        h(Text, { color: COLORS.ink, bold: true }, `目标 (${targets.length})`),
      ),
      targets.length === 0 ? h(Text, { color: COLORS.dim }, '还没有目标') : null,
      ...targets.map((row) => {
        const allowed = isTargetAllowedInMode(row, mode)
        return h(
          Box,
          {
            key: row.id,
            marginTop: 8,
            padding: 8,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 6,
            background: allowed ? '#fff' : COLORS.soft,
          },
          h(Text, { bold: true, color: COLORS.ink }, row.name),
          h(Text, { color: COLORS.dim }, `${row.authKind} · ${row.remoteWorkspaceRoot}`),
          h(
            Text,
            { color: !allowed ? COLORS.warn : row.status === 'online' ? COLORS.ok : COLORS.dim },
            !allowed
              ? `已隔离 · 需切换至 ${row.authKind === 'local' ? 'Local' : 'Remote'} 模式`
              : `status: ${row.status}${row.agentId ? ` · id ${row.agentId}` : ''}`,
          ),
          h(
            Box,
            { flexDirection: 'row', marginTop: 4 },
            ...DAEMON_ACTIONS.map((action) =>
              btn(action, () => mockDaemon(row, action), { disabled: busy || !allowed }),
            ),
            btn('删除', () => removeTarget(row.id), { danger: true }),
          ),
        )
      }),
      lastDaemon
        ? h(
            Box,
            { marginTop: 10 },
            h(Text, { color: COLORS.ink, bold: true }, '最近 mock daemon'),
            h(Text, { color: COLORS.dim }, JSON.stringify(lastDaemon)),
          )
        : null,
      h(
        Box,
        { marginTop: 12 },
        h(Text, { color: COLORS.dim }, '常驻配置在「设置 → Remote Agent」；本面板仅按需打开'),
        h(Text, { color: COLORS.dim }, '模型侧：tool::search/load 后调 remote::ping'),
      ),
    )
  }

  // 不自动挂到侧栏项目区：配置走设置；目标面板仅 Ctrl+Alt+R / 命令栏按需打开

  return () => {
    for (const fn of teardowns) fn()
    try {
      api.unmount(UI_ID)
    } catch {
      /* already gone */
    }
  }
}
