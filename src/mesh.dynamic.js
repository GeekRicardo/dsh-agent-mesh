// dsh-agent-mesh — one conversation opens, drives, watches, approves and
// configures OTHER conversations, exactly the way a human does.
//
// The whole point is that there is no second mechanism: a child conversation is
// an ordinary dsh conversation in an ordinary workspace, created and driven
// through `ctx.apiProxy` — the very API the web client calls when a person
// clicks "new conversation" and types into the composer. So the child shows up
// in the sidebar, renders natively, persists, and a human can take over at any
// moment simply by opening it.
//
// Two engines, one control path:
//   dsh     — the built-in loop; model/permission through apiProxy + presets
//   claude  — claude-in-dsh's engine, switched on through `ccmodeControl`
// Everything else (open / send / read / approve / stop) is identical for both,
// because a Claude turn is still a dsh turn writing dsh session events. The
// Claude engine is a SOFT dependency: without claude-in-dsh composed, only dsh
// children can be opened and the Claude knobs simply report their absence.
//
// Two faces onto the same operations:
//   native dsh tools  — a dsh model calls `agent_*` in-process (always on)
//   a wire server     — a Claude conversation or a remote node reaches the same
//                       operations over the network. Its protocol is chosen by
//                       config: `a2a` (default, the canonical Agent2Agent
//                       protocol) or `mcp` (JSON-RPC MCP). Claude Code speaks
//                       MCP as a tool client, so under `a2a` a thin MCP
//                       compatibility endpoint still fronts the A2A task engine.
//
// Approvals AND questions route to the parent: `approval/request` is a
// waterfall a prepended listener claims for a managed child, and — when the
// host composes the optional `userQuestions` waterfall — a child's question is
// claimed the same way. A parent that has stopped waiting is WOKEN for either,
// because delegated work that needs an answer is work its initiator must hear
// about.

return {
  inject: ['timer'],
  apply(ctx) {
    // One switch for the whole plugin. A deployment that does not want
    // conversations opening conversations says so without editing the plugin.
    if (typeof process !== 'undefined' && process.env && process.env.DSH_AGENT_MESH === 'off') {
      console.log('agent-mesh: disabled by DSH_AGENT_MESH=off')
      return
    }

    // Cross-session wire protocol. `a2a` (default) speaks the Agent2Agent
    // protocol between nodes and fronts a Claude conversation with an
    // MCP-shaped compatibility endpoint over the same task engine; `mcp` serves
    // the plain MCP endpoint with no A2A task machinery.
    const PROTOCOL = (typeof process !== 'undefined' && process.env && process.env.DSH_AGENT_MESH_PROTOCOL === 'mcp')
      ? 'mcp' : 'a2a'
    // How many Claude child processes may be resident at once. Each idle Claude
    // is a whole Node process (hundreds of MB); on a small machine the mesh
    // stops the least-recently-used idle one before starting another. 0 = no
    // limit. A stopped child resumes from ~/.claude on its next message.
    const MAX_LIVE_CLAUDE = (() => {
      const raw = typeof process !== 'undefined' && process.env ? process.env.DSH_AGENT_MESH_MAX_LIVE_CLAUDE : undefined
      const value = raw === undefined ? 2 : parseInt(raw, 10)
      return Number.isFinite(value) && value >= 0 ? value : 2
    })()

    // ---------- cross-machine (remote driver) ----------
    // A remote driver (e.g. a Claude Code session in another machine/container)
    // connects to the MCP/A2A wire endpoint from a non-loopback address. These
    // flags relax the loopback-only gate and publish a reachable endpoint, so a
    // single dsh can be driven by agents running elsewhere.
    const ALLOW_REMOTE = typeof process !== 'undefined' && process.env && process.env.DSH_AGENT_MESH_ALLOW_REMOTE === '1'
    const PUBLIC_HOST = typeof process !== 'undefined' && process.env && process.env.DSH_AGENT_MESH_PUBLIC_HOST || ''
    // A fixed bearer token for the wire endpoints, so a remote driver can hold
    // the same value across restarts. When empty, the mesh keeps its random
    // per-deployment token (fine for the loopback-only case).
    const REMOTE_TOKEN = typeof process !== 'undefined' && process.env && process.env.DSH_AGENT_MESH_TOKEN || ''

    // Bound late, never once. dsh mounts its rows in composition order, and a
    // bundle can easily apply BEFORE the API gateway it drives. `activate()`
    // waits for the gateway rather than giving up at apply().
    let apiProxy
    let sessionController
    let workspaceRegistry
    let agents
    let approval
    let commands
    let permissionPresets
    // Optional: only a deployment running claude-in-dsh can open Claude children.
    let ccmode

    const subprocess = ctx.get('subprocess')

    /** Live children, keyed by child session id. */
    const children = new Map()
    /** Pending human-in-the-loop requests the parent owes an answer, by request id. */
    const pending = new Map()
    /** Undelivered notices, by parent session id. */
    const notices = new Map()
    /** In-flight debounce per parent, so five children finishing at once cost one turn. */
    const deliveries = new Map()
    let requestCounter = 0

    const STATE_DIR = '"$HOME"/.cache/dsh-agent-mesh'
    const STATE_PATH = STATE_DIR + '/registry.json'
    let persistScheduled = false

    // ---------- small helpers (the sandbox has no node builtins) ----------

    function errorText(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      try { return JSON.stringify(error) } catch (ignored) { return String(error) }
    }

    function armTimeout(fn, ms) {
      try {
        const cancel = ctx.timeout(fn, ms)
        if (typeof cancel === 'function') return cancel
      } catch (error) { /* the fiber moved underneath us */ }
      return () => undefined
    }

    function sleep(ms) {
      return new Promise((resolve) => { armTimeout(resolve, ms) })
    }

    let rpcCounter = 0
    function rpcId(prefix) {
      rpcCounter += 1
      return 'agent-mesh-' + prefix + '-' + rpcCounter
    }

    function randomToken() {
      let token = ''
      for (let index = 0; index < 4; index += 1) token += Math.random().toString(36).slice(2, 12)
      return token
    }

    function nowMs() { return Date.now() }

    function runCapture(argv, timeoutMs) {
      return new Promise((resolve) => {
        if (subprocess === undefined) { resolve(''); return }
        let output = ''
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
        let proc
        try {
          proc = subprocess.spawn({
            argv: argv,
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
            graceMs: 2000,
          })
        } catch (error) { finish(''); return }
        ;(async () => {
          try { for await (const chunk of proc.stdout) output += String(chunk) } catch (error) { /* closed */ }
        })()
        proc.done.then(() => finish(output), () => finish(output))
        armTimeout(() => { try { proc.terminate() } catch (error) { /* gone */ } finish(output) }, timeoutMs || 10000)
      })
    }

    /** Write the registry out, coalesced — every mutation may call this. */
    function persist() {
      if (subprocess === undefined || persistScheduled) return
      persistScheduled = true
      armTimeout(() => {
        persistScheduled = false
        const out = { '#token': wireToken }
        for (const [childId, child] of children) {
          out[childId] = {
            parentId: child.parentId,
            engine: child.engine,
            cwd: child.cwd,
            approvals: child.approvals,
            notify: child.notify,
            cursor: child.cursor,
            openedAt: child.openedAt,
            lastActiveAt: child.lastActiveAt,
          }
        }
        try {
          const proc = subprocess.spawn({
            argv: ['/bin/sh', '-c', 'mkdir -p ' + STATE_DIR + ' && cat > ' + STATE_PATH],
            cwd: '/',
            stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 2000,
          })
          if (proc.stdin !== undefined) { proc.stdin.write(JSON.stringify(out)); proc.stdin.end() }
          proc.done.catch(() => undefined)
        } catch (error) {
          console.error('agent-mesh: could not persist the child registry:', errorText(error))
        }
      }, 400)
    }

    async function loadPersisted() {
      const raw = await runCapture(['/bin/sh', '-c', 'cat ' + STATE_PATH + ' 2>/dev/null'], 5000)
      let stored = null
      try { stored = JSON.parse(raw) } catch (error) { stored = null }
      if (stored === null || typeof stored !== 'object') {
        if (wireToken.length === 0) wireToken = randomToken()
        persist()
        return
      }
      if (REMOTE_TOKEN.length === 0 && typeof stored['#token'] === 'string' && stored['#token'].length >= 16) {
        wireToken = stored['#token']
      } else {
        // No usable token on disk: mint one and write it down BEFORE serving,
        // so the next activation adopts this one instead of minting its own.
        if (wireToken.length === 0) wireToken = randomToken()
        persist()
      }
      let restored = 0
      for (const childId of Object.keys(stored)) {
        if (childId.charAt(0) === '#' || children.has(childId)) continue
        const entry = stored[childId] || {}
        children.set(childId, {
          childId: childId,
          parentId: String(entry.parentId || ''),
          engine: entry.engine === 'dsh' ? 'dsh' : 'claude',
          cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
          approvals: ['parent', 'human', 'allow', 'deny'].indexOf(entry.approvals) >= 0 ? entry.approvals : 'parent',
          notify: entry.notify === 'off' ? 'off' : 'wake',
          blockingWait: false,
          cursor: typeof entry.cursor === 'number' ? entry.cursor : -1,
          openedAt: typeof entry.openedAt === 'number' ? entry.openedAt : 0,
          lastActiveAt: typeof entry.lastActiveAt === 'number' ? entry.lastActiveAt : (typeof entry.openedAt === 'number' ? entry.openedAt : 0),
        })
        restored += 1
      }
      if (restored > 0) console.log('agent-mesh: restored', restored, 'child conversation(s)')
    }

    /**
     * This Session's event log, across the two shapes dsh exposes it in.
     * 0.1.2 made the log private and serves immutable snapshots instead.
     */
    /** The last event's seq, or -1 for an empty log. */
    function lastSeqOf(session) {
      const logged = sessionEvents(session)
      return logged.length === 0 ? -1 : logged[logged.length - 1].seq
    }

    function sessionEvents(session) {
      if (session === null || session === undefined) return []
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      return Array.isArray(session.events) ? session.events : []
    }

    /**
     * The same nine calls, against dsh 0.1.2's per-domain controllers.
     *
     * Each adapter answers in the SHAPE the old apiProxy answered in, so the
     * nine call sites stay as they are: this is a transport change, not a
     * change to what the mesh does. Where 0.1.2 has no equivalent — session
     * history now needs a follow cursor a host plugin has no reason to hold —
     * the host-native path is used instead, which is the more direct answer
     * anyway: the child's log is right there on its agent.
     */
    const controllerApi = {
      sessions: {
        create: (payload) => sessionController.create(payload),
        rename: (payload) => sessionController.rename(payload),
        selectModel: (payload) => sessionController.selectModel(payload),
        // Synchronous in 0.1.2; the caller still awaits.
        cancel: (payload) => Promise.resolve(sessionController.cancel(payload)),
        models: () => sessionController.modelCatalog(),
        prompt: (payload, signal) => sessionController.prompt(
          // 0.1.2 requires the caller to mint the request id the old proxy
          // minted for it.
          { requestId: rpcId('prompt'), ...payload },
          signal === undefined ? new AbortController().signal : signal),
        history: async (payload) => {
          // `page()` wants an address plus a `throughSeq` from a follow frame.
          // A host plugin holding the agent does not need either — it reads the
          // log directly, and resolves a cold child first so an idle
          // conversation still answers.
          const sessionId = payload.sessionId
          if (sessionOf(sessionId) === undefined && typeof sessionController.resolveAgent === 'function') {
            try { await sessionController.resolveAgent(sessionId) } catch (error) { /* reported below */ }
          }
          const session = sessionOf(sessionId)
          if (session === undefined) throw new Error('agent-mesh: conversation ' + sessionId + ' is not readable')
          return { events: sessionEvents(session).map((event) => ({ event: event })) }
        },
      },
      workspace: {
        create: async (payload) => {
          const workspace = await workspaceRegistry.create(payload.path)
          return { workspace: workspaceView(workspace), created: true }
        },
        list: () => Promise.resolve({ items: workspaceRegistry.list().map(workspaceView) }),
      },
    }

    /** The registry entity, in the wire shape the mesh already speaks. */
    function workspaceView(workspace) {
      let sessionIds = []
      try { sessionIds = Array.from(workspace.sessionIds || []) } catch (error) { sessionIds = [] }
      return {
        workspaceId: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessionIds: sessionIds,
      }
    }

    /** Call one API method the way the web client does, and unwrap its result. */
    async function api(domain, method, payload, signal) {
      if (apiProxy === undefined) {
        const face = controllerApi[domain]
        const call = face === undefined ? undefined : face[method]
        if (typeof call !== 'function') {
          throw new Error('agent-mesh: this deployment has no ' + domain + '.' + method)
        }
        if (domain === 'workspace' && workspaceRegistry === undefined) {
          throw new Error('agent-mesh: this deployment publishes no workspaceRegistry')
        }
        return await call(payload, signal)
      }
      const face = apiProxy[domain]
      if (face === undefined || typeof face[method] !== 'function') {
        throw new Error('agent-mesh: this deployment has no ' + domain + '.' + method)
      }
      const request = { rpcId: rpcId(method), payload: payload }
      const response = signal === undefined
        ? await face[method](request)
        : await face[method](request, signal)
      const result = response === null || response === undefined ? undefined : response.result
      if (result === undefined) throw new Error('agent-mesh: ' + domain + '.' + method + ' returned nothing')
      if (result.ok !== true) {
        const error = result.error || {}
        throw new Error('agent-mesh: ' + domain + '.' + method + ' failed — '
          + (error.code === undefined ? '' : '[' + error.code + '] ') + (error.message || 'unknown'))
      }
      return result.value
    }

    function sessionOf(sessionId) {
      if (agents === undefined) return undefined
      try {
        const agent = agents.get(sessionId)
        return agent === undefined ? undefined : agent.session
      } catch (error) { return undefined }
    }

    function agentOf(sessionId) {
      if (agents === undefined) return undefined
      try { return agents.get(sessionId) } catch (error) { return undefined }
    }

    function truncate(text, max) {
      const value = typeof text === 'string' ? text : String(text === undefined ? '' : text)
      if (value.length <= max) return value
      return value.slice(0, max) + '…(+' + (value.length - max) + ' chars)'
    }

    // ---------- reading a conversation ----------

    /** Whether a conversation is mid-turn right now. */
    function isRunning(sessionId) {
      const session = sessionOf(sessionId)
      return session !== undefined && openTurn(sessionEvents(session))
    }

    /** Whether the log currently sits inside an open turn — i.e. the conversation is working. */
    function openTurn(events) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const type = events[index].type
        if (type === 'turn/start') return true
        if (type === 'turn/end') return false
      }
      return false
    }

    function titleOf(events) {
      let title = ''
      for (const event of events) {
        if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
          title = event.data.title
        }
      }
      return title
    }

    function blocksToText(blocks, budget) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block.type === 'reasoning') parts.push('(thinking …)')
        else if (block.type === 'image') parts.push('(image)')
        else if (block.type === 'tool-result') parts.push(blocksToText(block.content, budget))
      }
      return truncate(parts.join('\n').trim(), budget)
    }

    /**
     * How a turn ended, in the reader's terms. `blocked` is how the Claude
     * engine's own turns close (its pre-step owns the turn and then rejects the
     * model request), so reporting the raw kind would make every healthy Claude
     * round read like a failure.
     */
    function turnOutcome(reason) {
      const kind = reason === undefined || reason === null ? '?' : reason.kind || String(reason)
      if (kind === 'completed' || kind === 'blocked') return 'done'
      if (kind === 'aborted') return 'interrupted'
      if (kind === 'error') {
        const failure = reason.error || {}
        return 'FAILED: ' + truncate(failure.message || failure.code || 'unknown', 300)
      }
      return kind
    }

    /**
     * Fold a slice of the durable log into the lines a reader needs. Deliberately
     * lossy: the parent is reading a colleague's screen, not replaying the
     * session — the native UI already does that perfectly.
     */
    function renderEvents(events, fromSeq, options) {
      const detail = options === undefined || options.detail !== false
      const context = options !== undefined && options.context === true
      const lines = []
      let lastSeq = fromSeq
      for (const event of events) {
        if (event.seq <= fromSeq) continue
        lastSeq = event.seq
        const data = event.data || {}
        if (event.type === 'user/message') {
          const source = data.source || {}
          const human = source.kind === 'user'
          if (!human && !context) continue
          const text = blocksToText(data.content, human ? 1200 : 400)
          if (text.length > 0) lines.push('[' + (human ? 'said→child' : 'context(' + (source.kind || 'system') + ')') + '] ' + text)
        } else if (event.type === 'assistant/message') {
          const text = blocksToText(data.message === undefined ? [] : data.message.content, 4000)
          if (text.length > 0) lines.push('[assistant] ' + text)
        } else if (event.type === 'tool/call' && detail) {
          lines.push('[tool] ' + data.name + ' ' + truncate(data.arguments, 300))
        } else if (event.type === 'tool/result' && detail) {
          const message = data.message || {}
          const text = blocksToText(message.content, 600)
          lines.push('[tool→] ' + (data.error === undefined ? '' : 'ERROR ') + text)
        } else if (event.type === 'approval/asked') {
          lines.push('[approval?] ' + data.toolName + (data.reason === undefined ? '' : ' — ' + data.reason))
        } else if (event.type === 'approval/decided') {
          lines.push('[approval] ' + data.outcome)
        } else if (event.type === 'session/title') {
          lines.push('[title] ' + data.title)
        } else if (event.type === 'turn/end') {
          lines.push('[turn ' + data.turn + ' ' + turnOutcome(data.reason) + ']')
        }
      }
      return { lines: lines, lastSeq: lastSeq }
    }

    /** Everything a parent needs to decide what to do next with one child. */
    function statusOf(child) {
      const session = sessionOf(child.childId)
      const waiting = []
      for (const [id, entry] of pending) {
        if (entry.childId === child.childId) {
          waiting.push({ requestId: id, kind: entry.kind, toolName: entry.toolName, reason: entry.reason,
            ...(entry.callId === undefined ? {} : { callId: entry.callId }) })
        }
      }
      const claude = child.engine === 'claude' && ccmode !== undefined ? safeClaudeState(child.childId) : undefined
      const preset = child.engine === 'dsh' && permissionPresets !== undefined && session !== undefined
        ? safePreset(session)
        : undefined
      return {
        childId: child.childId,
        engine: child.engine,
        cwd: child.cwd,
        title: session === undefined ? '' : titleOf(sessionEvents(session)),
        live: session !== undefined,
        running: isRunning(child.childId),
        approvals: child.approvals,
        lastSeq: session === undefined ? child.cursor : lastSeqOf(session),
        cursor: child.cursor,
        awaiting: waiting,
        ...(claude === undefined ? {} : { claude: claude }),
        ...(preset === undefined ? {} : { permissionPreset: preset }),
      }
    }

    function safePreset(session) {
      try { return permissionPresets.current(sessionEvents(session)) } catch (error) { return undefined }
    }

    function safeClaudeState(childId) {
      try {
        const state = ccmode.state(childId)
        return { mode: state.mode, model: state.model || state.route || '', effort: state.effort, permissionMode: state.permissionMode, running: state.running }
      } catch (error) { return undefined }
    }

    // ---------- memory budget: keep only so many Claude processes resident ----------
    //
    // Each idle Claude is a whole Node process; on a small machine several of
    // them in RAM (and swap) is what makes the whole box stutter. Before the
    // mesh starts another Claude turn it stops the least-recently-used idle
    // managed Claude child, which frees the process; that child's conversation
    // is durable and resumes from ~/.claude on its next message.

    function touch(child) {
      child.lastActiveAt = nowMs()
    }

    /** Claude children with a resident process this mesh manages, newest last. */
    function liveClaudeChildren() {
      const live = []
      for (const child of children.values()) {
        if (child.engine !== 'claude') continue
        const state = ccmode === undefined ? undefined : safeClaudeState(child.childId)
        // `running` means mid-turn; a resident-but-idle process still counts
        // against the budget, which we detect through ccmode's live state.
        if (state !== undefined && (state.running === true || state.mode === 'claude')) live.push(child)
      }
      return live
    }

    /**
     * Stop idle managed Claude children until at most MAX_LIVE_CLAUDE remain
     * resident, never touching `keepChildId` (the one about to run) or one that
     * is mid-turn. Called before starting a Claude turn.
     */
    function enforceClaudeBudget(keepChildId) {
      if (MAX_LIVE_CLAUDE <= 0 || ccmode === undefined || typeof ccmode.stop !== 'function') return
      const live = liveClaudeChildren().filter((child) => child.childId !== keepChildId)
      // Count the one we are about to run as resident.
      if (live.length + 1 <= MAX_LIVE_CLAUDE) return
      const evictable = live
        .filter((child) => !isRunning(child.childId))
        .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0))
      let resident = live.length + 1
      for (const child of evictable) {
        if (resident <= MAX_LIVE_CLAUDE) break
        try {
          ccmode.stop(child.childId)
          resident -= 1
          console.log('agent-mesh: stopped idle Claude child', child.childId, '(memory budget', MAX_LIVE_CLAUDE + ')')
        } catch (error) { /* already gone */ }
      }
    }

    // ---------- opening a child ----------

    async function workspaceFor(cwd) {
      const created = await api('workspace', 'create', { path: cwd })
      return created.workspace.workspaceId
    }

    async function workspaceOf(sessionId) {
      const listed = await api('workspace', 'list', {})
      for (const workspace of listed.items) {
        if (workspace.sessionIds.indexOf(sessionId) >= 0) return workspace
      }
      return undefined
    }

    function cwdOf(sessionId) {
      const session = sessionOf(sessionId)
      if (session === undefined || session.header === undefined) return ''
      return typeof session.header.cwd === 'string' ? session.header.cwd : ''
    }

    async function openChild(parentId, options) {
      const engine = options.engine === 'dsh' ? 'dsh' : 'claude'
      if (ccmode === undefined) ccmode = ctx.get('ccmodeControl')
      if (engine === 'claude' && ccmode === undefined) {
        throw new Error('agent-mesh: this deployment has no Claude engine (claude-in-dsh is not composed) — open a dsh child instead')
      }
      const posture = typeof options.permissionMode === 'string' && options.permissionMode.length > 0
        ? options.permissionMode
        : undefined
      if (posture !== undefined) {
        if (engine === 'claude') assertClaudePosture(posture)
        else assertDshPreset(posture)
      }
      // Naming an existing project outright: the model saw it in
      // `agent_workspaces` and does not have to reconstruct its path.
      const askedWorkspace = typeof options.workspaceId === 'string' && options.workspaceId.length > 0
        ? options.workspaceId
        : undefined
      if (askedWorkspace !== undefined) {
        const known = (await api('workspace', 'list', {})).items
          .some((entry) => entry.workspaceId === askedWorkspace)
        if (!known) throw new Error('agent-mesh: no project with id ' + askedWorkspace + ' — see agent_workspaces')
      }
      const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : cwdOf(parentId)
      let workspaceId = askedWorkspace
      if (askedWorkspace !== undefined) {
        // An explicit project wins over any inherited or derived one.
      } else if (cwd.length > 0) {
        const parentWorkspace = await workspaceOf(parentId)
        workspaceId = parentWorkspace !== undefined && parentWorkspace.path === cwd
          ? parentWorkspace.workspaceId
          : await workspaceFor(cwd)
      } else {
        const parentWorkspace = await workspaceOf(parentId)
        workspaceId = parentWorkspace === undefined ? undefined : parentWorkspace.workspaceId
      }

      const created = await api('sessions', 'create',
        workspaceId === undefined ? {} : { workspaceId: workspaceId })
      const childId = created.sessionId

      const child = {
        childId: childId,
        parentId: parentId,
        engine: engine,
        cwd: cwd,
        approvals: ['parent', 'human', 'allow', 'deny'].indexOf(options.approvals) >= 0 ? options.approvals : 'parent',
        notify: options.notify === 'off' ? 'off' : 'wake',
        blockingWait: false,
        cursor: -1,
        openedAt: nowMs(),
        lastActiveAt: nowMs(),
      }
      children.set(childId, child)
      persist()

      if (engine === 'claude') {
        ccmode.setMode(childId, 'claude')
        // Where the child's Claude runs. Without an explicit target it inherits
        // whatever the last human choice left as the default — right for one
        // machine, wrong the moment you want one child here and one over there.
        if (typeof ccmode.setRemote === 'function'
          && (options.remote !== undefined || options.remoteCwd !== undefined)) {
          ccmode.setRemote(childId,
            typeof options.remote === 'string' ? options.remote : undefined,
            typeof options.remoteCwd === 'string' ? options.remoteCwd : undefined)
        }
        ccmode.setPosture(childId, posture === undefined
          ? (child.approvals === 'human' || child.approvals === 'parent' ? 'manual' : 'acceptEdits')
          : posture)
        if (typeof options.model === 'string' && options.model.length > 0) {
          ccmode.setModel(childId, options.model, options.effort)
        } else if (typeof options.effort === 'string' && options.effort.length > 0) {
          const state = ccmode.state(childId)
          ccmode.setModel(childId, state.model, options.effort)
        }
      } else {
        if (ccmode !== undefined) ccmode.setMode(childId, 'dsh')
        if (posture !== undefined) setDshPreset(childId, posture)
        if (typeof options.model === 'string' && options.model.length > 0) {
          await selectDshModel(childId, options.model, options.effort)
        }
      }

      if (typeof options.title === 'string' && options.title.trim().length > 0) {
        try { await api('sessions', 'rename', { sessionId: childId, title: options.title.trim() }) } catch (error) {
          console.error('agent-mesh: naming the child failed:', errorText(error))
        }
      }
      persist()
      console.log('agent-mesh:', parentId, 'opened', engine, 'child', childId, 'in', cwd || '(host cwd)')
      warnUnreachableParent(parentId)
      return child
    }

    /**
     * Say so, once per parent, when finished children will have nowhere to
     * report to.
     *
     * A notice is delivered by prompting the parent's dsh session. A parent id
     * that names no session — an external MCP driver addressing
     * `…/mcp/<handle>` — can only be reached through a `notifyUrl` webhook, and
     * without one every notice is queued and waits for the parent to ask.
     *
     * This is worth saying out loud because of how it happens in practice: the
     * plugin hands each Claude conversation its OWN per-session endpoint, but a
     * `dsh-agent-mesh` server in the user's own MCP config points at a fixed
     * handle, exposes the same tool names, and silently wins. The conversation
     * then delegates under an identity that cannot be notified, and the only
     * symptom is that finished children never say anything.
     */
    const warnedParents = new Set()
    function warnUnreachableParent(parentId) {
      if (warnedParents.has(parentId)) return
      if (sessionOf(parentId) !== undefined) return
      if (wireHooks.has(parentId)) return
      warnedParents.add(parentId)
      console.error('agent-mesh: "' + parentId + '" is not a dsh session, so finished children cannot wake it'
        + ' — notices will queue until this parent calls agent_* again.'
        + ' A conversation inside dsh should be addressing its OWN endpoint'
        + ' (/dsh-agent-mesh/mcp/<its session id>); a fixed handle here usually means an'
        + ' mcpServers entry of your own is shadowing the one this plugin injects.'
        + ' An external driver should register notifyUrl instead.')
    }

    // ---------- configuring a child ----------

    const CLAUDE_POSTURES = ['manual', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']

    function assertClaudePosture(name) {
      if (CLAUDE_POSTURES.indexOf(name) < 0) {
        throw new Error('agent-mesh: unknown Claude permission mode "' + name
          + '" (available: ' + CLAUDE_POSTURES.join(', ') + ')')
      }
      return name
    }

    function assertDshPreset(name) {
      if (permissionPresets === undefined) throw new Error('agent-mesh: this deployment composes no permission presets')
      const known = permissionPresets.names
      if (known.indexOf(name) < 0) {
        throw new Error('agent-mesh: unknown permission preset "' + name + '" (available: ' + known.join(', ') + ')')
      }
      return name
    }

    function setDshPreset(childId, name) {
      assertDshPreset(name)
      const session = sessionOf(childId)
      if (session === undefined) throw new Error('agent-mesh: ' + childId + ' is not live')
      permissionPresets.set(session, name)
      return name
    }

    async function selectDshModel(childId, model, effort) {
      const catalog = await api('sessions', 'models', { sessionId: childId })
      let provider
      for (const group of catalog.groups) {
        for (const entry of group.models) {
          if (entry.id === model) { provider = group.id; break }
        }
        if (provider !== undefined) break
      }
      if (provider === undefined) provider = catalog.current.provider
      return api('sessions', 'selectModel', {
        sessionId: childId,
        provider: provider,
        model: model,
        ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
      })
    }

    async function configureChild(child, options) {
      const applied = []
      if (child.engine === 'claude') {
        if (ccmode === undefined) throw new Error('agent-mesh: the Claude engine is gone')
        if (typeof options.permissionMode === 'string' && options.permissionMode.length > 0) {
          const state = ccmode.setPosture(child.childId, assertClaudePosture(options.permissionMode))
          applied.push('permissionMode=' + state.permissionMode)
        }
        if ((typeof options.model === 'string' && options.model.length > 0)
          || (typeof options.effort === 'string' && options.effort.length > 0)) {
          const current = ccmode.state(child.childId)
          const state = ccmode.setModel(child.childId,
            typeof options.model === 'string' && options.model.length > 0 ? options.model : current.model,
            options.effort)
          applied.push('model=' + (state.model || state.route || '?') + (state.effort ? ' effort=' + state.effort : ''))
        }
      } else {
        if (typeof options.permissionMode === 'string' && options.permissionMode.length > 0) {
          applied.push('permissionPreset=' + setDshPreset(child.childId, options.permissionMode))
        }
        if (typeof options.model === 'string' && options.model.length > 0) {
          const selected = await selectDshModel(child.childId, options.model, options.effort)
          applied.push('model=' + selected.selected.provider + '/' + selected.selected.model)
        }
      }
      if (options.notify === 'wake' || options.notify === 'off') {
        child.notify = options.notify
        persist()
        applied.push('notify=' + options.notify)
      }
      if (typeof options.approvals === 'string' && ['parent', 'human', 'allow', 'deny'].indexOf(options.approvals) >= 0) {
        child.approvals = options.approvals
        persist()
        applied.push('approvals=' + options.approvals)
        if (options.approvals !== 'parent') {
          for (const [id, entry] of Array.from(pending)) {
            if (entry.childId !== child.childId) continue
            pending.delete(id)
            entry.settle(options.approvals === 'allow' ? 'allowed-once' : options.approvals === 'deny' ? 'rejected' : 'unavailable')
          }
        }
      }
      return applied
    }

    // ---------- human-in-the-loop parked for the parent ----------
    //
    // Both an approval (tool permission) and a question (ask_user_question /
    // plan review) become a parked request the parent owes an answer. They
    // differ only in `kind` and in how the answer is shaped back to the child.

    function park(child, request) {
      requestCounter += 1
      const requestId = 'req-' + requestCounter
      return new Promise((resolve) => {
        let settled = false
        const entry = {
          childId: child.childId,
          kind: request.kind || 'approval',
          toolName: request.toolName,
          reason: request.reason,
          callId: request.callId,
          // A question carries the choices the parent picks from and shapes the
          // answer back into whatever the child's engine expects.
          questions: request.questions,
          shapeAnswer: request.shapeAnswer,
          askedAt: nowMs(),
          settle(outcome) {
            if (settled) return
            settled = true
            pending.delete(requestId)
            resolve(outcome)
          },
        }
        pending.set(requestId, entry)
        console.log('agent-mesh: parking', entry.kind, entry.toolName, 'from', child.childId, 'as', requestId,
          '— waiting for', child.parentId)
        queueNotice(child, entry.kind === 'question'
          ? noticeForQuestion(child, requestId, entry)
          : noticeForApproval(child, requestId, entry))
        a2aOnParked(child, requestId, entry)
        if (request.signal !== undefined) {
          try { request.signal.addEventListener('abort', () => entry.settle('cancelled'), { once: true }) } catch (error) { /* older signal */ }
        }
      })
    }

    function installApprovalBridge() {
      return ctx.on('approval/request', (request, next) => {
        const session = request.agent === undefined ? undefined : request.agent.session
        const childId = session === undefined ? '' : session.id
        const child = children.get(childId)
        if (child === undefined || child.approvals === 'human') return next()
        if (child.approvals === 'allow') return Promise.resolve('allowed-once')
        if (child.approvals === 'deny') return Promise.resolve('rejected')
        return park(child, { kind: 'approval', toolName: request.toolName, reason: request.reason, callId: request.callId, signal: request.signal })
      }, true)
    }

    /**
     * A dsh child's question routes to the parent the same way its approvals do,
     * through the user-questions answerer waterfall. Without it, a managed dsh child's
     * question still reaches the human UI — the parent is simply not the one
     * asked — so this bridge is best-effort and installs only when the seam
     * exists. A Claude child's question is routed by claude-in-dsh itself
     * (through `agentMeshControl.answerQuestion`), which never touches this.
     */
    function installQuestionBridge() {
      if (typeof ctx.on !== 'function') return () => undefined
      const disposers = []
      // dsh renamed this waterfall between 0.1.1-rc and 0.1.2 (camelCase to
      // hyphenated). Listening on both is two cheap registrations and spares
      // this bridge from silently doing nothing on whichever version it meets —
      // which is exactly what it did: the old name matched nothing on 0.1.2, so
      // a managed child's question went straight to the human card and the
      // parent was never told.
      for (const event of ['user-questions/request', 'userQuestions/request']) {
        try {
          disposers.push(ctx.on(event, (request, next) => {
          const agent = request.agent
          const session = agent === undefined ? undefined : agent.session
          const childId = session !== undefined && session.id !== undefined
            ? session.id
            : (agent === undefined ? '' : (agent.id || ''))
          const child = children.get(childId)
          if (child === undefined || child.approvals === 'human') return next()
          // A standing allow/deny has no meaning for a question (there is
          // nothing to allow), so those postures let the human answer.
          if (child.approvals === 'allow' || child.approvals === 'deny') return next()
          return parkQuestionForDshChild(child, request)
          }, true))
        } catch (error) {
          // An event this dsh does not define is not an error; the other name
          // in the list is the one that matters on this version.
        }
      }
      return () => { for (const dispose of disposers) { try { dispose() } catch (error) { /* gone */ } } }
    }

    /**
     * Route a managed dsh child's question to its parent. In this harness
     * `userQuestions` is a single-slot PROVIDER service (not a waterfall event),
     * and `ctx.userQuestions.provider` is the browser wire provider that shows
     * the human a question card. We wrap that one slot: a managed child with
     * approvals='parent' has its question parked for the parent; everything else
     * falls through to the human card exactly as before. The wrap is reversible
     * on teardown.
     */
    function installQuestionProvider() {
      const uq = ctx.get('userQuestions')
      if (uq === undefined) return () => undefined
      let disposed = false
      let retryTimer
      let restore = () => undefined
      // dsh 0.1.2 has no `provider` slot at all — answerers compose on the
      // user-questions waterfall instead. Waiting forever for a slot that will
      // never appear is an unbounded timer that also hides the fact that this
      // route is dead on this version, so give up after a bounded wait and let
      // the waterfall bridge carry it.
      let waited = 0
      const WRAP_GIVE_UP_MS = 30_000
      function tryWrap() {
        if (disposed) return
        // The browser wire provider registers during apiProxy activation; wait
        // for it rather than giving up if the mesh activates first.
        if (uq.provider === undefined) {
          waited += 500
          if (waited > WRAP_GIVE_UP_MS) {
            console.log('agent-mesh: this dsh has no userQuestions.provider slot'
              + ' — child questions route through the user-questions waterfall instead')
            return
          }
          retryTimer = armTimeout(tryWrap, 500)
          return
        }
        const prev = uq.provider
        const wrapper = { ask(request) {
          const agent = request.agent
          const childId = agent === undefined ? '' : (agent.id || '')
          const child = children.get(childId)
          if (child === undefined || child.approvals !== 'parent') return prev.ask(request)
          return parkQuestionForProvider(child, request)
        } }
        uq.provider = wrapper
        restore = () => { if (uq.provider === wrapper) uq.provider = prev }
      }
      tryWrap()
      return () => { disposed = true; if (retryTimer !== undefined) retryTimer(); restore() }
    }

    /**
     * The parking payload shared by both question routes: `userQuestions/request`
     * (deployments with the seam) and the wrapped `userQuestions` provider.
     */
    function questionParkPayload(child, request) {
      const questions = Array.isArray(request.questions) ? request.questions : []
      return {
        kind: 'question',
        toolName: 'ask_user_question',
        reason: questions.length > 0 ? questions[0].question : undefined,
        questions: questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description })) : [],
          multiSelect: q.multiSelect === true,
        })),
        signal: request.signal,
        // The parent answers by naming option labels (or free text) per
        // question; that becomes the service's answer object.
        shapeAnswer: (decision) => dshQuestionAnswer(questions, decision),
      }
    }

    /**
     * Park a dsh child's `userQuestions` request for the parent and shape the
     * chosen answer back into the `AskUserQuestionAnswer` the service returns.
     */
    function parkQuestionForDshChild(child, request) {
      return park(child, questionParkPayload(child, request)).then((outcome) => {
        // A question settles to an answer object when answered; a string
        // outcome means declined, cancelled, or the mesh tore down. The
        // waterfall must resolve to a valid answer, so a non-answer becomes a
        // rejection — the same shape as a human dismissing the question card.
        if (typeof outcome === 'string') {
          throw new Error('agent-mesh: the parent did not answer the question (' + outcome + ')')
        }
        return outcome
      })
    }

    /**
     * The provider route of the same question: a question answered through the
     * `userQuestions` provider. A non-answer (declined/cancelled/teardown)
     * becomes an EMPTY answer object, which lets the child model proceed as if
     * the human had dismissed the card, instead of a thrown tool error.
     */
    function parkQuestionForProvider(child, request) {
      return park(child, questionParkPayload(child, request)).then((outcome) => {
        if (typeof outcome === 'string') return { answers: [] }
        return outcome
      })
    }

    function dshQuestionAnswer(questions, decision) {
      // `decision` from agent_approve is { answers: [{ id, selected?, custom? }] }
      // or, for the simple allow/deny path, a string we treat as no answer.
      const provided = decision !== null && typeof decision === 'object' && Array.isArray(decision.answers)
        ? decision.answers : []
      const byId = new Map(provided.map((a) => [a.id, a]))
      const answers = []
      for (const question of questions) {
        const a = byId.get(question.id)
        answers.push({
          id: question.id,
          selected: a !== undefined && Array.isArray(a.selected) ? a.selected : [],
          ...(a !== undefined && typeof a.custom === 'string' && a.custom.trim() !== '' ? { custom: a.custom.trim() } : {}),
        })
      }
      return { answers: answers }
    }

    // ---------- waiting ----------

    async function settle(child, timeoutMs) {
      child.blockingWait = true
      try {
        const deadline = nowMs() + timeoutMs
        await sleep(250)
        while (nowMs() < deadline) {
          for (const entry of pending.values()) {
            if (entry.childId === child.childId) return 'awaiting-parent'
          }
          const session = sessionOf(child.childId)
          if (session === undefined) return 'idle'
          if (!openTurn(sessionEvents(session))) return 'idle'
          await sleep(400)
        }
        return 'timeout'
      } finally {
        child.blockingWait = false
      }
    }

    async function readSince(child, sinceSeq, options) {
      const session = sessionOf(child.childId)
      if (session !== undefined) return renderEvents(sessionEvents(session), sinceSeq, options)
      try {
        const page = await api('sessions', 'history', { sessionId: child.childId, maxMessages: 40 })
        return renderEvents(page.events.map((entry) => entry.event), sinceSeq, options)
      } catch (error) {
        return { lines: ['(cannot read ' + child.childId + ': ' + errorText(error) + ')'], lastSeq: sinceSeq }
      }
    }

    // ---------- telling the parent, when it has stopped listening ----------
    //
    // A parent that delegates and then stops talking has no way to learn that
    // its child finished, or that the child is now blocked on an approval or a
    // question only the parent can answer. dsh wakes an agent for a message
    // whose source is a person, so a notice is one ordinary message, delivered
    // to the parent conversation exactly as if someone walked over and said it.
    //
    // The cost is a turn, so it is spent carefully: once for a burst, and never
    // twice for the same event. Unlike the earlier design, an UNLOADED parent
    // is NOT skipped — delegated work that needs an answer is work its
    // initiator must hear about, and the prompt API resumes a cold conversation
    // to deliver, which is exactly waking the delegator.

    // A child that parked an approval/question or finished a turn always tells
    // its parent — unless the parent configured notify: 'off'. The only
    // suppression is while the parent is mid-turn in a BLOCKING WAIT on this
    // very child: there the blocking op's own tool result already carries the
    // status, so queueing a second copy would just waste a turn. The blocking
    // op's runOp drains otherwise-queued notices into the result as it returns,
    // so nothing is lost.

    function webhookPost(url, token, payload) {
      // Best-effort webhook into a REMOTE driver (cross-machine mesh). Unlike the
      // loopback-only `queueNotice`, this may cross the network: the driver is on
      // another machine, so its callback URL is reachable without a local dsh
      // session. Failures are logged, never thrown — the driver can still poll.
      if (typeof url !== 'string' || url.length === 0 || subprocess === undefined) return
      try {
        const proc = subprocess.spawn({
          argv: ['/usr/bin/env', 'curl', '-s', '-m', '5', '-X', 'POST',
            '-H', 'content-type: application/json',
            ...(token ? ['-H', 'authorization: Bearer ' + token] : []),
            '--data-binary', '@-', url],
          cwd: '/',
          stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 2000,
        })
        if (proc.stdin !== undefined) { proc.stdin.write(JSON.stringify(payload)); proc.stdin.end() }
        proc.done.catch(() => undefined)
      } catch (error) { console.error('agent-mesh: webhook to', url, 'failed:', errorText(error)) }
    }

    function queueNotice(child, text) {
      if (child.notify === 'off') return
      const parentId = child.parentId
      if (parentId.length === 0 || parentId === child.childId) return
      const hook = wireHooks.get(parentId)
      if (hook !== undefined) {
        // A remote driver: there is no local dsh session to wake (the parent id
        // is an external handle), so push the notice to the driver's webhook.
        webhookPost(hook.url, hook.token, {
          kind: 'notice', childId: child.childId, parentId: parentId,
          text: text, at: nowMs(),
        })
        return
      }
      const queued = notices.get(parentId) || []
      queued.push(text)
      while (queued.length > 8) queued.shift()
      notices.set(parentId, queued)

      const failed = (error) => console.error('agent-mesh: could not notify', parentId + ':', errorText(error))
      if (isRunning(parentId)) {
        // The parent is mid-turn. If it is blocked in a wait on this child, the
        // notice stays queued and the blocking op drains it into its own result.
        if (child.blockingWait) return
        const pendingTimer = deliveries.get(parentId)
        if (pendingTimer !== undefined) { deliveries.delete(parentId); pendingTimer() }
        deliverNotices(parentId).catch(failed)
        return
      }
      if (deliveries.has(parentId)) return
      deliveries.set(parentId, armTimeout(() => {
        deliveries.delete(parentId)
        deliverNotices(parentId).catch(failed)
      }, 3000))
    }

    function drainNotices(parentId) {
      const queued = notices.get(parentId)
      if (queued === undefined || queued.length === 0) return []
      notices.delete(parentId)
      const cancel = deliveries.get(parentId)
      if (cancel !== undefined) { deliveries.delete(parentId); cancel() }
      return queued
    }

    async function deliverNotices(parentId) {
      const queued = drainNotices(parentId)
      if (queued.length === 0) return
      // A running parent hears the news folded into its turn (`steer`); an idle
      // or fully unloaded one is WOKEN with a fresh turn (`queue` → followup,
      // which the prompt API resumes a cold conversation to start). This is the
      // whole point of a notice: the delegator asked to be told.
      const running = isRunning(parentId)
      try {
        await api('sessions', 'prompt', {
          sessionId: parentId,
          mode: running ? 'steer' : 'queue',
          content: [{ type: 'text', text: queued.join('\n\n') }],
        })
        console.log('agent-mesh: notified', parentId, 'about', queued.length, 'child event(s)', running ? '(steered)' : '(woke)')
      } catch (error) {
        // Put it back rather than losing it — the parent may just be busy.
        notices.set(parentId, (notices.get(parentId) || []).concat(queued))
        throw error
      }
    }

    function tailOf(child) {
      const session = sessionOf(child.childId)
      if (session === undefined) return ''
      const logged = sessionEvents(session)
      for (let index = logged.length - 1; index >= 0; index -= 1) {
        const event = logged[index]
        if (event.type !== 'assistant/message') continue
        const text = blocksToText(event.data.message === undefined ? [] : event.data.message.content, 700)
        if (text.length > 0) return text
      }
      return ''
    }

    function noticeForTurn(child) {
      const status = statusOf(child)
      const tail = tailOf(child)
      return '[子对话通知] ' + child.childId + (status.title ? ' 「' + status.title + '」' : '')
        + ' 跑完了这一轮。'
        + (tail.length === 0 ? '' : '\n最后一段：\n' + tail)
        + '\n用 agent_read 读全文（childId: ' + child.childId + '），或 agent_send 继续跟它说。'
    }

    function noticeForApproval(child, requestId, entry) {
      return '[子对话通知] ' + child.childId + ' 卡在一个权限请求上等你回答：'
        + requestId + ' · ' + entry.toolName + (entry.reason ? ' — ' + entry.reason : '')
        + '\n在你回答之前它一直阻塞着。用 agent_approve requestId=' + requestId + ' decision=allow|deny。'
    }

    function noticeForQuestion(child, requestId, entry) {
      const qs = Array.isArray(entry.questions) ? entry.questions : []
      const lines = qs.map((q) => {
        const opts = Array.isArray(q.options) && q.options.length > 0
          ? '\n   选项：' + q.options.map((o) => o.label).join(' / ')
          : ''
        return '· [' + q.id + '] ' + q.question + opts
      })
      return '[子对话通知] ' + child.childId + ' 在向你提问，等你回答（' + requestId + '）：\n'
        + lines.join('\n')
        + '\n用 agent_answer requestId=' + requestId + ' answers=[{id, selected:[标签], custom?}] 回答，'
        + '或 agent_approve requestId=' + requestId + ' decision=deny 表示不回答让它自己继续。'
    }

    function watchChildren() {
      return ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end') return
        const child = children.get(session.id)
        if (child === undefined) return
        const reason = event.data === undefined ? undefined : event.data.reason
        a2aOnTurnEnd(child, reason)
        if (reason !== undefined && reason.kind === 'aborted') return
        // A parent blocked in a wait on this child is told by that op's result;
        // do not also spend a second turn telling it the same turn ended.
        if (child.blockingWait) return
        queueNotice(child, noticeForTurn(child))
      })
    }

    function requireChild(childId) {
      const child = children.get(String(childId || ''))
      if (child === undefined) {
        const known = Array.from(children.keys())
        throw new Error('agent-mesh: no child conversation "' + childId + '" (open ones: '
          + (known.length === 0 ? 'none' : known.join(', ')) + ')')
      }
      return child
    }

    function parentOf(exec) {
      const agent = exec === undefined ? undefined : exec.agent
      if (agent === undefined) throw new Error('agent-mesh: this tool must be called from inside a conversation')
      return agent.session.id
    }

    function report(head, lines) {
      return lines.length === 0 ? head : head + '\n' + lines.join('\n')
    }

    // ---------- subscription usage, as an answer a model can plan against ----------

    function untilText(ms) {
      const minutes = Math.floor(ms / 60000)
      if (minutes <= 0) return 'now'
      if (minutes < 60) return minutes + 'm'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + 'h' + (minutes % 60 === 0 ? '' : (minutes % 60) + 'm')
      const days = Math.floor(hours / 24)
      return days + 'd' + (hours % 24 === 0 ? '' : (hours % 24) + 'h')
    }

    function usageAnswer(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.official !== true) {
        const reason = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.reason === 'string'
          ? snapshot.reason
          : 'no-oauth-subscription'
        return {
          official: false,
          reason: reason,
          report: reason === 'gateway-override'
            ? 'No subscription usage to report: this process runs against a gateway (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY is set), which meters separately.'
            : 'No subscription usage to report: this process is not signed in to a claude.ai subscription (API key or no login).',
        }
      }
      if (typeof snapshot.error === 'string' || !Array.isArray(snapshot.windows)) {
        return {
          official: true,
          subscription: snapshot.subscription || null,
          error: snapshot.error || 'usage endpoint unavailable',
          report: 'Subscription usage is currently unreadable (' + (snapshot.error || 'usage endpoint unavailable') + '). Try again later.',
        }
      }
      const now = nowMs()
      const windows = snapshot.windows.map((window) => {
        const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
        return {
          id: window.id,
          label: window.label,
          usedPercent: Math.round(window.utilization),
          remainingPercent: Math.max(0, 100 - Math.round(window.utilization)),
          resetsAt: window.resetsAt || null,
          resetsInMinutes: isNaN(at) ? null : Math.max(0, Math.round((at - now) / 60000)),
        }
      })
      const lines = windows.map((window) => '· ' + window.label + ': ' + window.usedPercent + '% used'
        + (window.resetsInMinutes === null
          ? ''
          : ' · resets in ' + untilText(window.resetsInMinutes * 60000) + ' (' + new Date(window.resetsAt).toLocaleString() + ')'))
      if (snapshot.extra !== undefined && snapshot.extra !== null) {
        lines.push('· extra usage: ' + Math.round(snapshot.extra.utilization) + '% (billed on top of the plan)')
      }
      const five = windows.find((window) => window.id === 'five_hour')
      if (five !== undefined) {
        lines.push('The 5h window is the one that stops a turn mid-flight: ' + five.remainingPercent + '% of it is left'
          + (five.resetsInMinutes === null ? '' : ', and it resets in ' + untilText(five.resetsInMinutes * 60000)) + '.')
      }
      return {
        official: true,
        subscription: snapshot.subscription || null,
        rateLimitTier: snapshot.rateLimitTier || null,
        windows: windows,
        ...(snapshot.extra === undefined || snapshot.extra === null
          ? {}
          : { extra: { usedPercent: Math.round(snapshot.extra.utilization), currency: snapshot.extra.currency || null } }),
        fetchedAt: snapshot.fetchedAt || null,
        report: report('Claude ' + String(snapshot.subscription || '').toUpperCase() + ' subscription usage:', lines),
      }
    }

    // ---------- the operations, defined once ----------

    const OPS = [
      {
        name: 'agent_open',
        description: 'Open a NEW dsh conversation and keep driving it, the way a person opens one in the sidebar. '
          + 'The child is a real conversation in a real workspace: it renders natively, persists, and a human can '
          + 'take it over at any time. Pick its engine — and mind the vocabulary, because both words name dsh things: '
          + 'a "dsh conversation" (`dsh`) is one driven by dsh\'s OWN built-in loop, while a "cc conversation" '
          + '(`claude`) is one driven by Claude Code through the claude-in-dsh plugin. "Open a dsh conversation in dsh" '
          + 'therefore means engine `dsh`, not merely "a conversation, in dsh". '
          + '(`claude` runs the Claude Code CLI, `dsh` runs the built-in '
          + 'loop), its model, and who answers its permission questions. Use this to delegate work that deserves its '
          + 'own conversation instead of your own context. You do NOT have to sit and poll: unless you pass '
          + '`notify: "off"`, the child wakes this conversation when it finishes a turn, gets stuck on an approval, '
          + 'or needs to ask you a question, so ending your reply with "waiting for it" is a valid thing to do.',
        parameters: {
          engine: { type: 'string', enum: ['claude', 'dsh'], description: 'Which engine drives the child. '
            + '`dsh` = a native dsh conversation, run by dsh\'s own loop — this is what "新建 dsh 对话" / '
            + '"a dsh conversation" asks for. `claude` = a cc conversation, run by Claude Code through '
            + 'claude-in-dsh — what "新建 cc 对话" asks for. Default claude.' },
          cwd: { type: 'string', description: 'Working directory for the child; defaults to this conversation\'s own. '
            + 'A directory with no project yet becomes one, which is how you start a new project.' },
          workspaceId: { type: 'string', description: 'Open the child in an EXISTING project, by the id '
            + '`agent_workspaces` reports. Takes precedence over `cwd`; use it instead of retyping a path.' },
          remote: { type: 'string', description: 'Claude engine only: which machine runs the child — the id of a '
            + 'configured SSH host or container, or "" for this one. Omit to inherit the deployment default.' },
          remoteCwd: { type: 'string', description: 'Claude engine only: the working directory ON that machine. '
            + 'Its paths are its own — a path from this machine means nothing there. Omit to reuse whatever that '
            + 'target was last worked in.' },
          title: { type: 'string', description: 'Name the child conversation (shown in the sidebar).' },
          model: { type: 'string', description: 'Model id for the child (engine-specific; omit for the default).' },
          effort: { type: 'string', description: 'Reasoning effort, when the engine exposes one.' },
          permissionMode: { type: 'string', description: 'Claude posture (manual/acceptEdits/auto/bypassPermissions/plan) or dsh permission preset.' },
          approvals: {
            type: 'string',
            enum: ['parent', 'human', 'allow', 'deny'],
            description: 'Who answers the child\'s permission questions: you (parent, default), the human at the UI, or a standing allow/deny.',
          },
          notify: {
            type: 'string',
            enum: ['wake', 'off'],
            description: 'Whether the child wakes you when it finishes a turn, gets stuck on an approval, or asks you a question (default wake).',
          },
          prompt: { type: 'string', description: 'First message to send once the child is open.' },
          wait: { type: 'boolean', description: 'With `prompt`, wait for the child to finish that turn (default true).' },
          timeoutSeconds: { type: 'number', description: 'How long to wait before returning with the turn still running (default 180).' },
          notifyUrl: { type: 'string', description: 'Cross-machine: webhook URL that receives this parent\'s child notices (approvals / completions). Register once; when set, no local dsh session is woken for this parent.' },
          notifyToken: { type: 'string', description: 'Optional bearer token sent with the notifyUrl webhook.' },
        },
        async run(parentId, args) {
          if (typeof args.notifyUrl === 'string' && args.notifyUrl.length > 0) {
            wireHooks.set(String(parentId || ''), {
              url: args.notifyUrl,
              token: typeof args.notifyToken === 'string' ? args.notifyToken : '',
            })
          }
          const child = await openChild(parentId, args)
          if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
            const status = statusOf(child)
            return {
              childId: child.childId,
              status: status,
              report: 'Opened ' + child.engine + ' conversation ' + child.childId
                + (child.cwd ? ' in ' + child.cwd : '') + '. Approvals go to: ' + child.approvals
                + '. Send it something with agent_send.',
            }
          }
          return send(child, args.prompt, 'auto', args.wait !== false, args.timeoutSeconds,
            'Opened ' + child.engine + ' conversation ' + child.childId + '. ')
        },
      },

      {
        name: 'agent_send',
        description: 'Say something to a child conversation, exactly as a human types into its composer. '
          + 'By default it CUTS IN (`auto`): when the child is mid-turn the message folds into the turn already '
          + 'running; when the child is idle it starts a new turn. Pass `mode: "queue"` to wait behind a running '
          + 'turn instead, or `mode: "steer"` to always fold into the current turn. In a dsh child a line starting '
          + 'with "/" runs that slash command through dsh\'s command registry instead of reaching the model (a '
          + 'Claude child gets the line as text, because its own CLI owns its commands). '
          + 'By default this waits for the child to finish and returns everything it produced.',
        parameters: {
          childId: { type: 'string', required: true, description: 'The child conversation to talk to.' },
          text: { type: 'string', required: true, description: 'What to say. In a dsh child a leading "/" runs a slash command.' },
          mode: { type: 'string', enum: ['auto', 'steer', 'queue'], description: 'auto (default) cuts in when the child is mid-turn; steer always folds in; queue waits behind the running turn.' },
          wait: { type: 'boolean', description: 'Wait for the turn to settle before returning (default true).' },
          timeoutSeconds: { type: 'number', description: 'Give up waiting after this long (default 180); the child keeps working.' },
        },
        run(parentId, args) {
          const child = requireChild(args.childId)
          return send(child, String(args.text), args.mode === 'steer' || args.mode === 'queue' ? args.mode : 'auto',
            args.wait !== false, args.timeoutSeconds, '')
        },
      },

      {
        name: 'agent_read',
        description: 'Read what a child conversation has produced since you last read it — its messages, tool calls, '
          + 'results and turn boundaries — plus whether it is still working and whether it is waiting on you for a '
          + 'permission decision or a question. Optionally block until it settles.',
        parameters: {
          childId: { type: 'string', required: true, description: 'The child conversation to read.' },
          sinceSeq: { type: 'number', description: 'Read after this log seq; omit to continue from your own cursor.' },
          waitSeconds: { type: 'number', description: 'Block up to this long for the child to settle or need you (default 0).' },
          detail: { type: 'boolean', description: 'Include tool calls and results (default true); false keeps only the conversation.' },
          context: { type: 'boolean', description: 'Also include dsh\'s injected runtime context and skill catalogs (default false).' },
        },
        async run(parentId, args) {
          const child = requireChild(args.childId)
          let outcome = 'read'
          if (typeof args.waitSeconds === 'number' && args.waitSeconds > 0) {
            outcome = await settle(child, Math.min(args.waitSeconds, 900) * 1000)
          }
          const from = typeof args.sinceSeq === 'number' ? args.sinceSeq : child.cursor
          const read = await readSince(child, from, { detail: args.detail !== false, context: args.context === true })
          child.cursor = read.lastSeq
          persist()
          const status = statusOf(child)
          return {
            childId: child.childId,
            status: status,
            outcome: outcome,
            report: report(headline(child, status, outcome), read.lines),
          }
        },
      },

      {
        name: 'agent_approve',
        description: 'Answer a permission question a child conversation is waiting on. The child is blocked inside '
          + 'its tool call until you answer, exactly as it would be waiting on a human. List what is waiting with '
          + 'agent_list or agent_read. For a child that is ASKING you a question (not a permission), use agent_answer.',
        parameters: {
          requestId: { type: 'string', required: true, description: 'The pending request id (from agent_read/agent_list).' },
          decision: { type: 'string', required: true, enum: ['allow', 'deny'], description: 'Allow this one call, or reject it.' },
          reason: { type: 'string', description: 'Why — recorded in the log for the human reading later.' },
        },
        run(parentId, args) {
          const entry = pending.get(String(args.requestId || ''))
          if (entry === undefined) {
            const open = Array.from(pending.keys())
            throw new Error('agent-mesh: nothing is waiting under "' + args.requestId + '" (waiting: '
              + (open.length === 0 ? 'none' : open.join(', ')) + ')')
          }
          if (entry.kind === 'question') {
            // A question answered through this path means "I decline to answer";
            // the child engine continues as if the human said nothing.
            entry.settle(args.decision === 'allow' ? entry.shapeAnswer({ answers: [] }) : 'declined')
            return {
              requestId: String(args.requestId),
              outcome: 'declined',
              report: 'Declined to answer ' + entry.childId + '\'s question; it continues on its own.',
            }
          }
          const outcome = args.decision === 'allow' ? 'allowed-once' : 'rejected'
          entry.settle(outcome)
          console.log('agent-mesh: parent answered', args.requestId, '=', outcome,
            args.reason === undefined ? '' : '(' + args.reason + ')')
          return {
            requestId: String(args.requestId),
            outcome: outcome,
            report: 'Answered ' + entry.toolName + ' for ' + entry.childId + ': ' + outcome + '.',
          }
        },
      },

      {
        name: 'agent_answer',
        description: 'Answer a QUESTION a child conversation is asking you (an ask_user_question or a plan review), '
          + 'exactly as a human would pick options in its question card. The child is blocked until you answer. '
          + 'Provide one entry per question id; `selected` names option labels, `custom` is free text.',
        parameters: {
          requestId: { type: 'string', required: true, description: 'The pending question id (from agent_read/agent_list).' },
          answers: {
            type: 'array',
            required: true,
            description: 'One entry per question: { id, selected: [labels], custom?: "free text" }.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
        run(parentId, args) {
          const entry = pending.get(String(args.requestId || ''))
          if (entry === undefined || entry.kind !== 'question') {
            const open = Array.from(pending.entries()).filter(([, e]) => e.kind === 'question').map(([id]) => id)
            throw new Error('agent-mesh: no question is waiting under "' + args.requestId + '" (waiting questions: '
              + (open.length === 0 ? 'none' : open.join(', ')) + ')')
          }
          const answer = entry.shapeAnswer({ answers: Array.isArray(args.answers) ? args.answers : [] })
          entry.settle(answer)
          console.log('agent-mesh: parent answered question', args.requestId, 'for', entry.childId)
          return {
            requestId: String(args.requestId),
            outcome: 'answered',
            report: 'Answered ' + entry.childId + '\'s question.',
          }
        },
      },

      {
        name: 'agent_config',
        description: 'Change how a child conversation runs, mid-conversation: its model, its reasoning effort, its '
          + 'permission posture, and who answers its permission questions. Same knobs the human has in that '
          + 'conversation\'s own composer.',
        parameters: {
          childId: { type: 'string', required: true, description: 'The child conversation to reconfigure.' },
          model: { type: 'string', description: 'Model id (engine-specific).' },
          effort: { type: 'string', description: 'Reasoning effort, when the engine exposes one.' },
          permissionMode: { type: 'string', description: 'Claude posture, or dsh permission preset name.' },
          approvals: { type: 'string', enum: ['parent', 'human', 'allow', 'deny'], description: 'Where the child\'s permission questions go.' },
          notify: { type: 'string', enum: ['wake', 'off'], description: 'Whether this child wakes you when it finishes or needs an approval.' },
        },
        async run(parentId, args) {
          const child = requireChild(args.childId)
          const applied = await configureChild(child, args)
          const status = statusOf(child)
          return {
            childId: child.childId,
            status: status,
            report: applied.length === 0
              ? 'Nothing to change. ' + headline(child, status, 'read')
              : 'Applied to ' + child.childId + ': ' + applied.join(', ') + '.',
          }
        },
      },

      {
        name: 'agent_stop',
        description: 'Stop a child conversation. `cancel` interrupts the turn it is running (pending queued input '
          + 'survives, exactly like the human\'s stop button). `close` also ends its engine process and stops '
          + 'managing it — the conversation itself stays in the sidebar for a human to continue.',
        parameters: {
          childId: { type: 'string', required: true, description: 'The child conversation to stop.' },
          action: { type: 'string', enum: ['cancel', 'close'], description: 'cancel the current turn (default), or close the child.' },
        },
        async run(parentId, args) {
          const child = requireChild(args.childId)
          const close = args.action === 'close'
          try { await api('sessions', 'cancel', { sessionId: child.childId }) } catch (error) {
            console.log('agent-mesh: cancel', child.childId, '—', errorText(error))
          }
          for (const [id, entry] of Array.from(pending)) {
            if (entry.childId === child.childId) { pending.delete(id); entry.settle('cancelled') }
          }
          a2aOnStopped(child, close)
          if (close) {
            if (child.engine === 'claude' && ccmode !== undefined) {
              try { ccmode.stop(child.childId) } catch (error) { /* already gone */ }
            }
            children.delete(child.childId)
            persist()
          }
          return {
            childId: child.childId,
            report: (close ? 'Closed ' : 'Interrupted ') + child.childId
              + (close ? '. The conversation stays in the sidebar.' : '. It can be sent more input.'),
          }
        },
      },

      {
        name: 'agent_workspaces',
        description: 'List the projects that already exist in dsh — the same ones a person sees in the sidebar. '
          + 'Use this before agent_open to put a child in an existing project (pass its `workspaceId`) instead of '
          + 'guessing a path; a directory that has no project yet becomes one when you pass it as `cwd`.',
        parameters: {},
        async run() {
          const items = (await api('workspace', 'list', {})).items
          const lines = items.map((entry) => '· ' + entry.title + '  [' + entry.workspaceId + ']'
            + '\n    ' + entry.path
            + '  · ' + entry.sessionIds.length + ' 个会话')
          return {
            workspaces: items.map((entry) => ({
              workspaceId: entry.workspaceId,
              title: entry.title,
              path: entry.path,
              sessions: entry.sessionIds.length,
            })),
            report: items.length === 0
              ? 'dsh has no projects yet — pass a `cwd` to agent_open and one is created there.'
              : report('Projects in dsh:', lines),
          }
        },
      },

      {
        name: 'agent_list',
        description: 'List the child conversations you opened: engine, working directory, whether each is running, '
          + 'and which permission questions or questions are waiting on you.',
        parameters: {
          all: { type: 'boolean', description: 'Include children opened by other conversations (default false).' },
        },
        run(parentId, args) {
          const rows = []
          const lines = []
          for (const child of children.values()) {
            if (args.all !== true && child.parentId !== parentId) continue
            const status = statusOf(child)
            rows.push(status)
            lines.push('· ' + headline(child, status, 'read'))
          }
          return {
            children: rows,
            report: rows.length === 0 ? 'No child conversations open.' : report('Child conversations:', lines),
          }
        },
      },

      {
        name: 'claude_usage',
        description: 'Read the local Claude Code subscription usage: how much of each rate-limit window '
          + '(5h, 7d, 7d Opus, 7d Sonnet) is spent and when it resets. Use it to plan before you commit — '
          + 'split a long task, hand part of it to a child conversation, or wait for the window — instead of '
          + 'discovering the limit halfway through a turn. Reports nothing useful when this machine runs '
          + 'against an API key or a third-party gateway, which have no subscription windows.',
        parameters: {
          refresh: { type: 'boolean', description: 'Refetch instead of answering from the 60s cache (default false).' },
        },
        async run(parentId, args) {
          if (ccmode === undefined) ccmode = ctx.get('ccmodeControl')
          if (ccmode === undefined || typeof ccmode.usage !== 'function') {
            throw new Error('agent-mesh: this deployment has no Claude engine (claude-in-dsh is not composed) — no subscription usage to read')
          }
          return usageAnswer(await ccmode.usage(args.refresh === true))
        },
      },
    ]

    const opsByName = new Map(OPS.map((op) => [op.name, op]))

    async function runOp(name, parentId, args) {
      const op = opsByName.get(name)
      if (op === undefined) throw new Error('agent-mesh: no such operation "' + name + '"')
      if (typeof parentId !== 'string' || parentId.length === 0) {
        throw new Error('agent-mesh: ' + name + ' needs to know which conversation is asking')
      }
      const value = await op.run(parentId, args === null || args === undefined ? {} : args)
      const waiting = drainNotices(parentId)
      if (waiting.length === 0 || value === null || typeof value !== 'object') return value
      return {
        ...value,
        report: (typeof value.report === 'string' ? value.report + '\n\n' : '') + waiting.join('\n\n'),
      }
    }

    const OUTPUT = {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: typeof value.report === 'string' ? value.report : JSON.stringify(value) }],
    }

    const tools = OPS.map((op) => harness.defineTool({
      name: op.name,
      description: op.description,
      parameters: op.parameters,
      output: OUTPUT,
      execute: (args, exec) => Promise.resolve(runOp(op.name, parentOf(exec), args)),
    }))

    function headline(child, status, outcome) {
      const bits = [child.childId, child.engine]
      if (status.title) bits.push('“' + status.title + '”')
      if (status.claude !== undefined) {
        bits.push((status.claude.model || 'default') + '/' + status.claude.permissionMode
          + (status.claude.effort ? '/' + status.claude.effort : ''))
      } else if (status.permissionPreset !== undefined) {
        bits.push(status.permissionPreset)
      }
      bits.push(status.running ? 'RUNNING' : 'idle')
      if (status.awaiting.length > 0) {
        bits.push('WAITING ON YOU: ' + status.awaiting
          .map((entry) => entry.requestId + ' (' + (entry.kind === 'question' ? 'question' : entry.toolName) + (entry.reason ? ' — ' + entry.reason : '') + ')')
          .join('; '))
      }
      if (outcome === 'timeout') bits.push('(still working — read again later)')
      return bits.join(' · ')
    }

    async function runChildCommand(child, line) {
      if (commands === undefined) {
        console.log('agent-mesh: no command registry — "' + line + '" goes to the model instead')
        return undefined
      }
      const agent = agentOf(child.childId)
      if (agent === undefined) return undefined
      const signal = typeof AbortController === 'undefined'
        ? { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {}, onabort: null, throwIfAborted() {} }
        : new AbortController().signal
      let execution
      try {
        execution = await commands.execute(agent, line, [], signal)
      } catch (error) {
        try {
          execution = await commands.execute(agent, line, signal)
        } catch (older) {
          throw new Error('agent-mesh: ' + line + ' failed in ' + child.childId + ' — ' + errorText(error))
        }
      }
      if (execution === undefined) {
        console.log('agent-mesh: "' + line + '" is not a command in', child.childId, '— sending it as a message')
        return undefined
      }
      const result = execution.result || {}
      return {
        name: line.slice(1).split(/\s+/)[0],
        kind: result.kind === undefined ? 'success' : result.kind,
        ...(result.text === undefined ? {} : { text: truncate(result.text, 600) }),
      }
    }

    async function send(child, text, mode, wait, timeoutSeconds, prefix) {
      const before = sessionOf(child.childId)
      const from = before === undefined ? -1 : lastSeqOf(before)
      touch(child)
      if (child.engine === 'dsh' && text.charAt(0) === '/') {
        const outcome = await runChildCommand(child, text)
        if (outcome !== undefined) {
          child.cursor = from
          persist()
          return {
            childId: child.childId,
            command: outcome,
            report: prefix + '/' + outcome.name + ' in ' + child.childId + ': '
              + outcome.kind + (outcome.text === undefined ? '' : ' — ' + outcome.text),
          }
        }
      }
      // Free a Claude slot before this one starts talking, so the box does not
      // hold one more resident process than the budget allows.
      if (child.engine === 'claude') enforceClaudeBudget(child.childId)
      // `auto` (default) cuts in: fold into the running turn, or start a new one
      // when the child is idle. Explicit steer/queue win over the default.
      const resolved = mode === 'steer' || mode === 'queue' ? mode : (isRunning(child.childId) ? 'steer' : 'queue')
      const value = await api('sessions', 'prompt', {
        sessionId: child.childId,
        mode: resolved,
        content: [{ type: 'text', text: text }],
      })
      a2aOnSend(child, text)
      if (!wait) {
        child.cursor = from
        return {
          childId: child.childId,
          status: statusOf(child),
          report: prefix + 'Sent (' + resolved + '). ' + headline(child, statusOf(child), 'read')
            + (child.notify === 'off' ? '' : ' — you will be told when it finishes.'),
        }
      }
      const seconds = typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? Math.min(timeoutSeconds, 900) : 180
      const outcome = await settle(child, seconds * 1000)
      touch(child)
      const read = await readSince(child, from, { detail: true })
      child.cursor = read.lastSeq
      persist()
      const status = statusOf(child)
      return {
        childId: child.childId,
        status: status,
        outcome: outcome,
        report: prefix + report(headline(child, status, outcome), read.lines),
      }
    }

    // ---------- the control service claude-in-dsh reads ----------
    //
    // Published under the SAME name claude-in-dsh already consumes to build a
    // Claude child's `--mcp-config`, so composing this plugin instead of the
    // embedded half needs no change there. `answerQuestion` lets claude-in-dsh
    // route a Claude child's ask_user_question / plan-review to the child's
    // parent instead of the human UI.

    // Deliberately EMPTY until the registry says what the token is.
    //
    // It used to start as a fresh random value that the registry load then
    // replaced. Every activation of this plugin therefore had its own random
    // token for a while — and a plugin reloads often (this deployment had
    // activated nineteen times in one dsh run). A Claude process launched
    // against one activation's token then met another activation's validator
    // and got 401 forever, with the only symptom being that the mesh tools
    // silently vanished from that conversation.
    //
    // Starting empty and filling from the registry makes every activation
    // converge on the SAME token, so a long-lived child keeps working across
    // reloads. Requests that arrive before it is known are refused as
    // not-ready rather than measured against a value nobody else has.
    let wireToken = REMOTE_TOKEN
    let wireEndpointHost = ''
    // Remote drivers register a webhook per parent session id, so approvals /
    // completions from a child reach the driver even when it is not a local dsh
    // session (loopback-only `queueNotice` would otherwise fall through).
    const wireHooks = new Map()
    let registryReady = Promise.resolve()

    function publish() {
      return ctx.provide('multiagentControl', {
        operations: () => OPS.map((op) => ({ name: op.name, description: op.description, parameters: op.parameters })),
        run: (name, parentId, args) => runOp(String(name), String(parentId), args),
        endpoint: async (sessionId) => {
          await registryReady
          if (wireEndpointHost.length === 0) return null
          return {
            url: 'http://' + wireEndpointHost + MCP_PATH + '/' + encodeURIComponent(String(sessionId)),
            token: wireToken,
          }
        },
        /**
         * Whether the conversation `childId` is a managed child, and if so who
         * its parent is — claude-in-dsh asks this before deciding to route a
         * Claude child's question to the mesh rather than the human UI.
         */
        childInfo: (childId) => {
          const child = children.get(String(childId))
          if (child === undefined) return null
          return { childId: child.childId, parentId: child.parentId, engine: child.engine, approvals: child.approvals }
        },
        /**
         * Route one Claude child's question to its parent and resolve with the
         * chosen answers (a map keyed by question TEXT, which is what the Claude
         * CLI wants back). Rejects/args:
         *   childId   the asking child
         *   questions [{ id, header, question, options:[{label,description}], multiSelect }]
         *   signal    the turn's abort signal
         * Resolves to { answered: boolean, answers: { [questionText]: string } }.
         * A child whose parent does not supervise it (approvals !== 'parent')
         * resolves `answered:false` so claude-in-dsh falls back to the human UI.
         */
        answerQuestion: async (childId, questions, signal) => {
          const child = children.get(String(childId))
          if (child === undefined || child.approvals !== 'parent') return { answered: false, answers: {} }
          const items = Array.isArray(questions) ? questions : []
          if (items.length === 0) return { answered: false, answers: {} }
          const outcome = await park(child, {
            kind: 'question',
            toolName: 'ask_user_question',
            reason: items[0].question,
            questions: items,
            signal: signal,
            // The parent's chosen labels/custom become a text map keyed by the
            // question TEXT, which is the shape the Claude CLI consumes.
            shapeAnswer: (decision) => claudeQuestionAnswer(items, decision),
          })
          if (typeof outcome === 'string') return { answered: false, answers: {} }
          return { answered: true, answers: outcome }
        },
      })
    }

    function claudeQuestionAnswer(items, decision) {
      const provided = decision !== null && typeof decision === 'object' && Array.isArray(decision.answers)
        ? decision.answers : []
      const byId = new Map(provided.map((a) => [a && a.id, a]))
      const textOf = new Map(items.map((q) => [q.id, q.question]))
      const answers = {}
      for (const question of items) {
        const a = byId.get(question.id)
        if (a === undefined) continue
        const parts = []
        for (const label of Array.isArray(a.selected) ? a.selected : []) {
          if (typeof label === 'string' && label.trim() !== '') parts.push(label.trim())
        }
        if (typeof a.custom === 'string' && a.custom.trim() !== '') parts.push(a.custom.trim())
        if (parts.length > 0) answers[textOf.get(question.id)] = parts.join(', ')
      }
      return answers
    }

    // ---------- transports (MCP + A2A) live in their own sections ----------

    const MCP_PATH = '/dsh-agent-mesh/mcp'
    const A2A_PATH = '/dsh-agent-mesh/a2a'

    // These are set up by mountTransports(); the A2A hooks below are no-ops
    // until then, so the core never depends on a transport being present.
    let a2aOnParked = () => undefined
    let a2aOnTurnEnd = () => undefined
    let a2aOnSend = () => undefined
    let a2aOnStopped = () => undefined

    function inputSchemaOf(op) {
      const properties = {}
      const required = []
      for (const key of Object.keys(op.parameters)) {
        const spec = op.parameters[key]
        const property = {}
        for (const field of Object.keys(spec)) {
          if (field === 'required') continue
          property[field] = spec[field]
        }
        if (spec.required === true) required.push(key)
        properties[key] = property
      }
      return { type: 'object', properties: properties, ...(required.length === 0 ? {} : { required: required }) }
    }

    function isLoopback(address) {
      if (typeof address !== 'string') return false
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
        || address.indexOf('127.') === 0
    }

    function respondJson(res, status, body) {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(text)
    }

    function rpcError(res, id, code, message) {
      respondJson(res, 200, { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } })
    }

    async function readBody(req) {
      const decoder = new TextDecoder()
      let text = ''
      for await (const chunk of req) {
        text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      }
      return text + decoder.decode()
    }

    function guardWire(req, res) {
      if (!ALLOW_REMOTE && !isLoopback(req.socket === undefined ? '' : req.socket.remoteAddress)) {
        res.writeHead(403, { 'content-type': 'text/plain' }); res.end('agent-mesh: loopback only'); return false
      }
      if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
        res.writeHead(403, { 'content-type': 'text/plain' }); res.end('agent-mesh: cross-site denied'); return false
      }
      const authorization = String(req.headers.authorization || '')
      if (wireToken.length === 0) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('agent-mesh: still loading its registry — retry in a moment')
        return false
      }
      if (authorization !== 'Bearer ' + wireToken) {
        res.writeHead(401, { 'content-type': 'text/plain' }); res.end('agent-mesh: bad or missing bearer token'); return false
      }
      return true
    }

    // ----- MCP endpoint (always mounted: Claude Code speaks MCP as a client) --

    async function handleMcp(req, res) {
      if (!guardWire(req, res)) return
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' }); res.end('agent-mesh: POST only'); return
      }
      const url = String(req.url || '')
      const path = url.split('?')[0]
      const parentId = path.length > MCP_PATH.length ? decodeURIComponent(path.slice(MCP_PATH.length + 1)) : ''

      let message
      try { message = JSON.parse(await readBody(req)) } catch (error) {
        rpcError(res, null, -32700, 'agent-mesh: unparsable JSON-RPC body'); return
      }
      const id = message === null || typeof message !== 'object' ? null : message.id
      const method = message === null || typeof message !== 'object' ? '' : String(message.method || '')
      const params = (message && message.params) || {}

      if (id === undefined || id === null) {
        res.writeHead(202, { 'content-type': 'application/json' }); res.end(''); return
      }
      if (method === 'initialize') {
        respondJson(res, 200, {
          jsonrpc: '2.0', id: id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'dsh-agent-mesh', version: '0.1.0' },
          },
        })
        return
      }
      if (method === 'ping') { respondJson(res, 200, { jsonrpc: '2.0', id: id, result: {} }); return }
      if (method === 'tools/list') {
        respondJson(res, 200, {
          jsonrpc: '2.0', id: id,
          result: { tools: OPS.map((op) => ({ name: op.name, description: op.description, inputSchema: inputSchemaOf(op) })) },
        })
        return
      }
      if (method === 'tools/call') {
        const name = String(params.name || '')
        try {
          const value = await runOp(name, parentId, params.arguments)
          respondJson(res, 200, {
            jsonrpc: '2.0', id: id,
            result: { content: [{ type: 'text', text: typeof value.report === 'string' ? value.report : JSON.stringify(value) }], isError: false },
          })
        } catch (error) {
          respondJson(res, 200, { jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: errorText(error) }], isError: true } })
        }
        return
      }
      rpcError(res, id, -32601, 'agent-mesh: unsupported MCP method "' + method + '"')
    }

    // ----- A2A server (the canonical Agent2Agent protocol) -------------------
    //
    // Each managed conversation is exposed as one A2A agent (an Agent Card at
    // `${A2A_PATH}/agent-card/<parentSessionId>` and a JSON-RPC endpoint at
    // `${A2A_PATH}/<parentSessionId>`). A driver acts AS one conversation: the
    // path names the parent, and every op runs on that parent's behalf, exactly
    // like the MCP endpoint. A2A adds the task lifecycle: a `message/send`
    // creates a Task whose status walks working → input-required → completed,
    // and a registered push-notification config is how a blocked child wakes a
    // driver that is not streaming.

    const a2a = installA2A()

    function installA2A() {
      /** taskId → { id, contextId, childId, parentId, status, history, artifacts, subscribers } */
      const tasks = new Map()
      /** parentId → push-notification config { url, token } */
      const pushConfigs = new Map()
      /** requestId (parked) → taskId, so answering unblocks the right task. */
      const parkedTask = new Map()
      let taskCounter = 0

      function newTaskId() { taskCounter += 1; return 'task-' + taskCounter + '-' + randomToken().slice(0, 8) }

      function messageText(message) {
        const parts = message && Array.isArray(message.parts) ? message.parts : []
        const out = []
        for (const part of parts) {
          if (part && part.kind === 'text' && typeof part.text === 'string') out.push(part.text)
          else if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text)
        }
        return out.join('\n')
      }

      function textMessage(role, text) {
        return { role: role, parts: [{ kind: 'text', text: String(text) }], messageId: 'msg-' + randomToken().slice(0, 8), kind: 'message' }
      }

      function taskView(task) {
        return {
          id: task.id,
          contextId: task.contextId,
          kind: 'task',
          status: { state: task.status, timestamp: new Date(task.statusAt).toISOString(), ...(task.statusMessage ? { message: task.statusMessage } : {}) },
          history: task.history.slice(-20),
          artifacts: task.artifacts,
        }
      }

      function emit(task, event) {
        for (const subscriber of task.subscribers) {
          try { subscriber(event) } catch (error) { /* a dropped SSE client */ }
        }
      }

      function setStatus(task, state, message) {
        task.status = state
        task.statusAt = nowMs()
        task.statusMessage = message
        if (message !== undefined) task.history.push(message)
        emit(task, {
          kind: 'status-update',
          taskId: task.id, contextId: task.contextId,
          status: { state: state, timestamp: new Date(task.statusAt).toISOString(), ...(message ? { message: message } : {}) },
          final: state === 'completed' || state === 'failed' || state === 'canceled',
        })
        if (state === 'input-required' || state === 'completed' || state === 'failed') firePush(task)
      }

      function firePush(task) {
        const config = pushConfigs.get(task.parentId)
        if (config === undefined || typeof config.url !== 'string') return
        // Best-effort webhook: the A2A way for a blocked/finished task to reach
        // a driver that is not holding an SSE stream open. Loopback only.
        try {
          if (subprocess === undefined) return
          const body = JSON.stringify(taskView(task))
          const proc = subprocess.spawn({
            argv: ['/usr/bin/env', 'curl', '-s', '-m', '5', '-X', 'POST',
              '-H', 'content-type: application/json',
              ...(config.token ? ['-H', 'authorization: Bearer ' + config.token] : []),
              '--data-binary', '@-', config.url],
            cwd: '/',
            stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 2000,
          })
          if (proc.stdin !== undefined) { proc.stdin.write(body); proc.stdin.end() }
          proc.done.catch(() => undefined)
        } catch (error) { /* the driver can still poll tasks/get */ }
      }

      // The task attached to a child's CURRENT activity, created on send.
      function activeTaskFor(childId) {
        for (const task of tasks.values()) {
          if (task.childId === childId && (task.status === 'working' || task.status === 'submitted' || task.status === 'input-required')) return task
        }
        return undefined
      }

      return {
        // --- core hooks, called from the operations above ---
        onSend(child, text) {
          let task = activeTaskFor(child.childId)
          if (task === undefined) {
            task = {
              id: newTaskId(), contextId: child.childId, childId: child.childId, parentId: child.parentId,
              status: 'submitted', statusAt: nowMs(), history: [], artifacts: [], subscribers: new Set(),
            }
            tasks.set(task.id, task)
          }
          task.history.push(textMessage('user', text))
          setStatus(task, 'working')
          return task
        },
        onParked(child, requestId, entry) {
          const task = activeTaskFor(child.childId)
          if (task === undefined) return
          parkedTask.set(requestId, task.id)
          const label = entry.kind === 'question' ? 'question' : ('approval: ' + entry.toolName)
          setStatus(task, 'input-required', textMessage('agent', 'needs input — ' + label + (entry.reason ? ' — ' + entry.reason : '')))
        },
        onTurnEnd(child, reason) {
          const task = activeTaskFor(child.childId)
          if (task === undefined) return
          // A turn ending while input is required is the child still blocked,
          // not the task finishing.
          if (task.status === 'input-required') return
          const kind = reason === undefined || reason === null ? 'completed' : reason.kind
          if (kind === 'aborted') { setStatus(task, 'canceled'); return }
          if (kind === 'error') {
            setStatus(task, 'failed', textMessage('agent', turnOutcome(reason)))
            return
          }
          const tail = tailOf(child)
          if (tail.length > 0) task.artifacts.push({ artifactId: 'reply-' + randomToken().slice(0, 6), parts: [{ kind: 'text', text: tail }] })
          setStatus(task, 'completed', tail.length > 0 ? textMessage('agent', tail) : undefined)
        },
        onStopped(child, close) {
          const task = activeTaskFor(child.childId)
          if (task !== undefined) setStatus(task, 'canceled')
        },
        // Called by agent_approve/agent_answer indirectly through pending.settle;
        // we also clear the parked→task mapping here.
        resolveParked(requestId) {
          const taskId = parkedTask.get(requestId)
          if (taskId === undefined) return
          parkedTask.delete(requestId)
          const task = tasks.get(taskId)
          if (task !== undefined && task.status === 'input-required') setStatus(task, 'working')
        },
        messageText, textMessage, taskView, tasks, pushConfigs, setStatus, activeTaskFor, newTaskId,
      }
    }

    async function handleA2A(req, res) {
      if (!guardWire(req, res)) return
      const url = String(req.url || '')
      const path = url.split('?')[0]

      // Agent Card: GET ${A2A_PATH}/agent-card/<parentSessionId>
      const cardPrefix = A2A_PATH + '/agent-card/'
      if (req.method === 'GET' && path.indexOf(cardPrefix) === 0) {
        const parentId = decodeURIComponent(path.slice(cardPrefix.length))
        respondJson(res, 200, agentCard(parentId))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' }); res.end('agent-mesh: POST or GET agent-card'); return
      }
      const parentId = path.length > A2A_PATH.length ? decodeURIComponent(path.slice(A2A_PATH.length + 1)) : ''

      let message
      try { message = JSON.parse(await readBody(req)) } catch (error) {
        rpcError(res, null, -32700, 'agent-mesh: unparsable JSON-RPC body'); return
      }
      const id = message === null || typeof message !== 'object' ? null : message.id
      const method = message === null || typeof message !== 'object' ? '' : String(message.method || '')
      const params = (message && message.params) || {}

      try {
        if (method === 'message/send') { await a2aMessageSend(res, id, parentId, params, false); return }
        if (method === 'message/stream') { await a2aMessageSend(res, id, parentId, params, true); return }
        if (method === 'tasks/get') { a2aTasksGet(res, id, params); return }
        if (method === 'tasks/cancel') { await a2aTasksCancel(res, id, params); return }
        if (method === 'tasks/resubscribe') { a2aResubscribe(res, id, params); return }
        if (method === 'tasks/pushNotificationConfig/set') { a2aPushSet(res, id, parentId, params); return }
        if (method === 'tasks/pushNotificationConfig/get') { a2aPushGet(res, id, parentId); return }
        rpcError(res, id, -32601, 'agent-mesh: unsupported A2A method "' + method + '"')
      } catch (error) {
        rpcError(res, id, -32603, errorText(error))
      }
    }

    function agentCard(parentId) {
      return {
        protocolVersion: '0.2.5',
        name: 'dsh-agent-mesh',
        description: 'Drive dsh/Claude child conversations as A2A tasks on behalf of conversation ' + parentId,
        url: 'http://' + wireEndpointHost + A2A_PATH + '/' + encodeURIComponent(parentId),
        version: '0.1.0',
        capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: OPS.map((op) => ({ id: op.name, name: op.name, description: truncate(op.description, 240), tags: ['dsh', 'agent-mesh'] })),
      }
    }

    /**
     * A2A `message/send`: a message either OPENS work (no taskId → run one of
     * the agent_* operations named by a `metadata.op`, defaulting to a plain
     * agent_send to the message text) or CONTINUES a task waiting for input
     * (taskId present → answer the parked approval/question). Streaming variant
     * holds an SSE connection and emits status-update events.
     */
    async function a2aMessageSend(res, id, parentId, params, streaming) {
      const message = params.message || {}
      const text = a2a.messageText(message)
      const taskId = message.taskId || params.taskId
      const op = message.metadata && message.metadata.op ? String(message.metadata.op) : undefined
      const args = (message.metadata && message.metadata.arguments) || {}

      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      }

      // Continue a task waiting for input: the message answers the parked
      // request. We locate the parked request for this parent's child.
      if (taskId !== undefined) {
        const task = a2a.tasks.get(String(taskId))
        if (task === undefined) { finishRpc(res, id, streaming, null, { code: -32001, message: 'task not found' }); return }
        answerParkedFromMessage(task, text, args)
        if (streaming) { streamTask(res, task); return }
        finishRpc(res, id, streaming, a2a.taskView(task))
        return
      }

      // Open work: run the named operation (default agent_send when a childId
      // is supplied, else agent_open with the text as the prompt).
      let value
      if (op !== undefined) {
        value = await runOp(op, parentId, args)
      } else if (args.childId !== undefined) {
        value = await runOp('agent_send', parentId, { childId: args.childId, text: text, wait: false })
      } else {
        value = await runOp('agent_open', parentId, { ...args, prompt: text, wait: false })
      }
      const childId = value && value.childId
      const task = childId !== undefined ? a2a.activeTaskFor(childId) : undefined
      if (task === undefined) {
        // An operation with no running child (a read, a config) answers as a
        // one-shot message rather than a task.
        finishRpc(res, id, streaming, a2a.textMessage('agent', typeof value.report === 'string' ? value.report : JSON.stringify(value)))
        return
      }
      if (streaming) { streamTask(res, task); return }
      finishRpc(res, id, streaming, a2a.taskView(task))
    }

    function answerParkedFromMessage(task, text, args) {
      // Find the parked request for this task's child and settle it. The
      // message's metadata may carry an explicit decision/answers; otherwise
      // free text becomes the custom answer / an approval allow.
      for (const [requestId, entry] of pending) {
        if (entry.childId !== task.childId) continue
        if (entry.kind === 'question') {
          const answers = Array.isArray(args.answers) ? args.answers
            : (text ? entry.questions.map((q) => ({ id: q.id, selected: [], custom: text })) : [])
          entry.settle(entry.shapeAnswer({ answers: answers }))
        } else {
          const decision = args.decision || (text && /^(deny|no|reject)/i.test(text) ? 'deny' : 'allow')
          entry.settle(decision === 'deny' ? 'rejected' : 'allowed-once')
        }
        return
      }
    }

    function streamTask(res, task) {
      const write = (event) => {
        try {
          res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', result: event }) + '\n\n')
        } catch (error) { /* client gone */ }
      }
      write({ ...a2a.taskView(task) })
      task.subscribers.add(write)
      const final = (event) => {
        write(event)
        if (event.final === true) {
          task.subscribers.delete(write)
          try { res.end() } catch (error) { /* already closed */ }
        }
      }
      task.subscribers.delete(write)
      task.subscribers.add(final)
      try { req_on_close(res, () => task.subscribers.delete(final)) } catch (error) { /* no close hook */ }
    }

    function req_on_close(res, fn) {
      const req = res.req
      if (req !== undefined && typeof req.on === 'function') req.on('close', fn)
    }

    function a2aTasksGet(res, id, params) {
      const task = a2a.tasks.get(String(params.id))
      if (task === undefined) { rpcError(res, id, -32001, 'task not found'); return }
      respondJson(res, 200, { jsonrpc: '2.0', id: id, result: a2a.taskView(task) })
    }

    async function a2aTasksCancel(res, id, params) {
      const task = a2a.tasks.get(String(params.id))
      if (task === undefined) { rpcError(res, id, -32001, 'task not found'); return }
      const child = children.get(task.childId)
      if (child !== undefined) { try { await runOp('agent_stop', task.parentId, { childId: task.childId, action: 'cancel' }) } catch (error) { /* already idle */ } }
      a2a.setStatus(task, 'canceled')
      respondJson(res, 200, { jsonrpc: '2.0', id: id, result: a2a.taskView(task) })
    }

    function a2aResubscribe(res, id, params) {
      const task = a2a.tasks.get(String(params.id))
      if (task === undefined) { rpcError(res, id, -32001, 'task not found'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      streamTask(res, task)
    }

    function a2aPushSet(res, id, parentId, params) {
      const config = params.pushNotificationConfig || params.config || {}
      if (typeof config.url !== 'string' || config.url.length === 0) { rpcError(res, id, -32602, 'pushNotificationConfig.url required'); return }
      a2a.pushConfigs.set(parentId, { url: config.url, token: config.token })
      respondJson(res, 200, { jsonrpc: '2.0', id: id, result: { pushNotificationConfig: { url: config.url, ...(config.token ? { token: config.token } : {}) } } })
    }

    function a2aPushGet(res, id, parentId) {
      const config = a2a.pushConfigs.get(parentId)
      respondJson(res, 200, { jsonrpc: '2.0', id: id, result: config === undefined ? {} : { pushNotificationConfig: { url: config.url } } })
    }

    function finishRpc(res, id, streaming, result, error) {
      if (streaming) {
        try {
          res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: id, ...(error ? { error: error } : { result: result }) }) + '\n\n')
          res.end()
        } catch (e) { /* client gone */ }
        return
      }
      if (error) { rpcError(res, id, error.code, error.message); return }
      respondJson(res, 200, { jsonrpc: '2.0', id: id, result: result })
    }

    // Wire the A2A hooks into the core now that the server exists. A settle on a
    // parked request also advances its task back to `working`.
    function wireA2AHooks() {
      a2aOnParked = (child, requestId, entry) => {
        a2a.onParked(child, requestId, entry)
        const originalSettle = entry.settle
        entry.settle = (outcome) => { a2a.resolveParked(requestId); return originalSettle(outcome) }
      }
      a2aOnTurnEnd = (child, reason) => a2a.onTurnEnd(child, reason)
      a2aOnSend = (child, text) => a2a.onSend(child, text)
      a2aOnStopped = (child, close) => a2a.onStopped(child, close)
    }

    // ---------- activation ----------

    const disposers = []
    let activations = 0

    function activate() {
      // dsh served every browser-facing domain through one `apiProxy` up to
      // 0.1.1-rc. 0.1.2 split it into per-domain controllers, so either shape
      // is enough to drive a conversation; the workspace side is better served
      // by the host registry, which both versions publish.
      apiProxy = ctx.get('apiProxy')
      sessionController = ctx.get('sessionController')
      workspaceRegistry = ctx.get('workspaceRegistry')
      if (apiProxy === undefined && sessionController === undefined) {
        activations += 1
        if (activations <= 60) { armTimeout(activate, 1000); return }
        console.error('agent-mesh: neither apiProxy nor sessionController in this deployment'
          + ' — conversations cannot open conversations')
        return
      }
      agents = ctx.get('agents')
      approval = ctx.get('approval')
      commands = ctx.get('commands')
      permissionPresets = ctx.get('permissionPresets')
      ccmode = ctx.get('ccmodeControl')

      if (PROTOCOL === 'a2a') wireA2AHooks()

      for (const tool of tools) disposers.push(harness.registerTool(ctx, tool))
      disposers.push(installApprovalBridge())
      disposers.push(installQuestionBridge())
      disposers.push(installQuestionProvider())
      disposers.push(watchChildren())
      disposers.push(publish())
      mountTransports()

      registryReady = loadPersisted()
      registryReady
        .then(() => {
          console.log('agent-mesh: ready — ' + tools.length + ' tools; protocol=' + PROTOCOL
            + (wireEndpointHost.length === 0
              ? ', no wire endpoint (no web server)'
              : ', MCP at http://' + wireEndpointHost + MCP_PATH + '/<parent>'
                + (PROTOCOL === 'a2a' ? ', A2A at http://' + wireEndpointHost + A2A_PATH + '/<parent>' : ''))
            + '; Claude engine ' + (ccmode === undefined ? 'absent' : 'present')
            + '; approval routing ' + (approval === undefined ? 'off' : 'on')
            + '; maxLiveClaude=' + (MAX_LIVE_CLAUDE === 0 ? '∞' : MAX_LIVE_CLAUDE)
            + (activations === 0 ? '' : ' (waited ' + activations + 's for the API gateway)'))
        })
        .catch((error) => console.error('agent-mesh: could not restore the registry:', errorText(error)))
    }

    function mountTransports() {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) {
        console.log('agent-mesh: no web server in this deployment — dsh tools only, no wire endpoint')
        return
      }
      // Claude Code always needs an MCP endpoint (its tool client speaks MCP);
      // under `a2a` the A2A endpoint is mounted alongside it for node-to-node
      // and streaming/push.
      disposers.push(webServer.register({
        kind: 'prefix', path: MCP_PATH,
        handler: (req, res) => handleMcp(req, res).catch((error) => {
          console.error('agent-mesh: MCP request failed:', errorText(error))
          try { rpcError(res, null, -32603, errorText(error)) } catch (ignored) { /* already sent */ }
        }),
      }))
      if (PROTOCOL === 'a2a') {
        disposers.push(webServer.register({
          kind: 'prefix', path: A2A_PATH,
          handler: (req, res) => handleA2A(req, res).catch((error) => {
            console.error('agent-mesh: A2A request failed:', errorText(error))
            try { rpcError(res, null, -32603, errorText(error)) } catch (ignored) { /* already sent */ }
          }),
        }))
      }
      wireEndpointHost = PUBLIC_HOST.length > 0 ? PUBLIC_HOST : '127.0.0.1:' + webServer.port
    }

    ctx.effect(() => () => {
      for (const [id, entry] of Array.from(pending)) { pending.delete(id); entry.settle('unavailable') }
      for (const dispose of disposers) dispose()
    }, 'agent-mesh teardown')

    activate()
  },
}
