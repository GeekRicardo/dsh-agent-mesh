// dsh-agent-mesh drives OTHER conversations through the very API the web client
// calls, so these tests stand a fake apiProxy (plus a fake agent registry,
// approval + question waterfalls, and Claude-engine control) behind the engine
// and assert on what it does to them: what it creates, what it sends, what it
// reads back, who ends up answering a child's permission question or question,
// how it keeps the Claude process budget, and how the A2A task engine reflects
// all of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const body = fs.readFileSync(path.join(root, 'src/mesh.dynamic.js'), 'utf8')

function event(seq, type, data) { return { seq, type, data } }

function harnessBench(options = {}) {
  const sessions = new Map()
  const prompts = []
  const cancelled = []
  const commandLines = []
  const listeners = { 'approval/request': [], 'userQuestions/request': [], 'user-questions/request': [], 'session/event': [] }
  const claudeState = new Map()
  const remoteCalls = []
  const stopped = []
  const usageCalls = []
  const usageSnapshot = { value: options.usage ?? { official: false, reason: 'no-oauth-subscription' } }
  const routes = []
  let provided
  let created = 0

  const makeSession = (id, cwd) => {
    const events = []
    const session = {
      id,
      header: { cwd },
      events,
      push(type, data) { events.push(event(events.length, type, data)) },
    }
    sessions.set(id, session)
    return session
  }

  const ok = (value) => Promise.resolve({ rpcId: 'r', result: { ok: true, value } })

  const apiProxy = {
    sessions: {
      create() {
        created += 1
        const id = 'child-' + created
        makeSession(id, '/work')
        return ok({ sessionId: id })
      },
      prompt(request) {
        const { sessionId, mode, content } = request.payload
        // 让测试能让某一次投递失败：真实里 steer 会输给「这一轮刚好结束了」。
        if (options.onPrompt !== undefined) options.onPrompt({ sessionId, mode })
        prompts.push({ sessionId, mode, text: content.map(part => part.text).join('') })
        // A cold conversation is resumed by the real prompt path; the bench
        // simulates that by materializing the session on demand.
        const session = sessions.get(sessionId) ?? makeSession(sessionId, '/work')
        session.push('turn/start', { turn: 1 })
        session.push('user/message', { content, source: { kind: 'user' } })
        return ok({ accepted: true })
      },
      cancel(request) { cancelled.push(request.payload.sessionId); return ok({ accepted: true }) },
      rename(request) {
        const session = sessions.get(request.payload.sessionId)
        session.push('session/title', { title: request.payload.title })
        return ok({ title: request.payload.title, seq: session.events.length - 1 })
      },
      models() {
        return ok({
          current: { provider: 'deepseek-official', model: 'deepseek-chat' },
          routable: true,
          groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-reasoner', name: 'R' }] }],
          failures: [],
        })
      },
      selectModel(request) {
        return ok({ selected: { provider: request.payload.provider, model: request.payload.model } })
      },
      history(request) {
        const session = sessions.get(request.payload.sessionId)
        return ok({ events: session.events.map(entry => ({ event: entry })), hasMore: false })
      },
    },
    workspace: {
      create() { return ok({ workspace: { workspaceId: 'ws-1', path: '/work', sessionIds: [] }, created: false }) },
      list() { return ok({ items: [{ workspaceId: 'ws-1', path: '/work', sessionIds: ['parent-1'] }], archivedSessionIds: [] }) },
    },
  }

  // dsh 0.1.2 拆掉了 apiProxy：每个域一个控制器，收普通载荷、直接返回值、
  // 失败靠抛而不是 {ok:false}。工作区改由 host 侧的注册表回答，list() 是同步的。
  const sessionController = {
    create(request) {
      created += 1
      const id = 'child-' + created
      makeSession(id, '/work')
      return Promise.resolve({ sessionId: id })
    },
    prompt(request) {
      if (typeof request.requestId !== 'string' || request.requestId.length === 0) {
        throw new Error('0.1.2 要求调用方自己给 requestId')
      }
      const { sessionId, mode, content } = request
      // 让测试能让某一次投递失败：真实里 steer 会输给「这一轮刚好结束了」。
      if (options.onPrompt !== undefined) options.onPrompt({ sessionId, mode })
      prompts.push({ sessionId, mode, text: content.map(part => part.text).join('') })
      const session = sessions.get(sessionId) ?? makeSession(sessionId, '/work')
      session.push('turn/start', { turn: 1 })
      session.push('user/message', { content, source: { kind: 'user' } })
      return Promise.resolve({ accepted: true })
    },
    cancel(request) { cancelled.push(request.sessionId); return { accepted: true } },
    rename(request) {
      const session = sessions.get(request.sessionId)
      session.push('session/title', { title: request.title })
      return Promise.resolve({ title: request.title, seq: session.events.length - 1 })
    },
    modelCatalog() {
      return Promise.resolve({
        default: { provider: 'deepseek-official', model: 'deepseek-chat' },
        routableProviders: ['deepseek-official'],
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-reasoner', name: 'R' }] }],
        failures: [],
      })
    },
    selectModel(request) {
      return Promise.resolve({ selected: { provider: request.provider, model: request.model } })
    },
    resolveAgent(sessionId) {
      if (!sessions.has(sessionId)) makeSession(sessionId, '/work')
      return Promise.resolve({ ok: true })
    },
  }

  const workspaceRegistry = {
    list: () => [{ id: 'ws-1', path: '/work', title: 'work', sessionIds: ['parent-1'] }],
    create: (path) => Promise.resolve({ id: 'ws-2', path, title: 'made', sessionIds: [] }),
  }

  const services = {
    ...(options.dsh === '0.1.2' ? { sessionController, workspaceRegistry } : { apiProxy }),
    agents: {
      get: (id) => (sessions.has(id) ? { id, session: sessions.get(id) } : undefined),
      list: () => Array.from(sessions.values()).map(session => ({ id: session.id, session })),
    },
    approval: {},
    userQuestions: {
      provider: { ask: () => Promise.resolve({ answers: [] }) },
    },
    permissionPresets: {
      names: ['read-only', 'workspace-write', 'danger-full-access'],
      set(session, name) { session.push('permission/preset', { preset: name }) },
      current(events) {
        let preset = 'workspace-write'
        for (const entry of events) if (entry.type === 'permission/preset') preset = entry.data.preset
        return preset
      },
    },
    commands: {
      execute(agent, line, images, signal) {
        assert.ok(Array.isArray(images), 'the command registry is handed an images array')
        assert.ok(signal !== undefined, 'the command registry is handed a signal')
        commandLines.push({ sessionId: agent.session.id, line })
        if (!line.startsWith('/permission')) return Promise.resolve(undefined)
        return Promise.resolve({ commandId: 'c1', result: { kind: 'success', text: 'preset read-only' } })
      },
    },
    ccmodeControl: {
      state: (id) => claudeState.get(id) ?? { mode: 'dsh', model: '', effort: '', permissionMode: 'manual', running: false },
      setMode(id, mode) { const state = { ...this.state(id), mode }; claudeState.set(id, state); return state },
      setRemote(id, remote, remoteCwd) {
        remoteCalls.push({ id, remote, remoteCwd })
        const state = { ...this.state(id), remote: remote ?? '', remoteCwd: remoteCwd ?? '' }
        claudeState.set(id, state)
        return state
      },
      setPosture(id, permissionMode) { const state = { ...this.state(id), permissionMode }; claudeState.set(id, state); return state },
      setModel(id, model, effort) { const state = { ...this.state(id), model, effort: effort ?? '' }; claudeState.set(id, state); return state },
      stop(id) { stopped.push(id); return true },
      usage: (force) => { usageCalls.push(force === true); return usageSnapshot.value },
    },
    webServer: options.webServer === false ? undefined : {
      port: 8999,
      register(route) { routes.push(route); return () => {} },
    },
  }

  let gatewayReady = options.gateway !== 'late'
  const ctx = {
    get: (name) => ((name === 'apiProxy' || name === 'sessionController') && !gatewayReady
      ? undefined
      : services[name]),
    on(name, listener) { (listeners[name] ??= []).push(listener); return () => {} },
    provide(name, value) { provided = value; return () => {} },
    effect() { return () => {} },
    timeout(fn, ms) { const handle = setTimeout(fn, Math.min(ms, 20)); return () => clearTimeout(handle) },
    tools: { register: () => () => {} },
  }

  const registered = []
  const harness = {
    defineTool: (definition) => definition,
    registerTool: (_ctx, tool) => { registered.push(tool); return () => {} },
  }

  const half = new Function('harness', 'console', body)(harness, console)
  half.apply(ctx)

  const call = (name, args, parentId = 'parent-1') => {
    const tool = registered.find(entry => entry.name === name)
    assert.ok(tool !== undefined, `tool ${name} is registered`)
    return tool.execute(args ?? {}, { agent: { id: parentId, session: sessions.get(parentId) } })
  }

  // A minimal loopback HTTP call into one of the mounted wire routes.
  async function wire(prefix, { method = 'POST', urlPath = '', bodyObj, token, accept } = {}) {
    const route = routes.find(entry => entry.path === prefix)
    assert.ok(route !== undefined, `route ${prefix} mounted`)
    const bodyText = bodyObj === undefined ? '' : JSON.stringify(bodyObj)
    const req = (async function* () { if (bodyText) yield bodyText })()
    req.method = method
    req.url = prefix + (urlPath ? '/' + urlPath : '')
    req.headers = { authorization: 'Bearer ' + token, ...(accept ? { accept } : {}) }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.on = () => {}
    const chunks = []
    let status = 0
    const res = {
      req,
      writeHead(code) { status = code },
      write(chunk) { chunks.push(String(chunk)) },
      end(chunk) { if (chunk) chunks.push(String(chunk)) },
    }
    await route.handler(req, res)
    return { status, text: chunks.join(''), json: () => JSON.parse(chunks.join('')) }
  }

  makeSession('parent-1', '/work')
  return {
    call, wire, sessions, prompts, cancelled, commandLines, listeners, claudeState, registered, services,
    usageCalls, usageSnapshot, stopped, routes, makeSession, remoteCalls,
    control: () => provided,
    openGateway() { gatewayReady = true },
  }
}

/** Fire the `turn/end` dsh appends when a conversation stops working. */
function endTurn(bench, childId, reason = { kind: 'blocked' }) {
  const session = bench.sessions.get(childId)
  session.push('turn/end', { turn: 1, reason })
  for (const listener of bench.listeners['session/event'] ?? []) listener(session, session.events.at(-1))
}

const settled = () => new Promise(resolve => setTimeout(resolve, 60))

// ---------- core operations ----------

test('every operation reaches the model as a tool', () => {
  const bench = harnessBench()
  assert.deepEqual(bench.registered.map(tool => tool.name).sort(), [
    'agent_answer', 'agent_approve', 'agent_config', 'agent_list', 'agent_open', 'agent_read', 'agent_send',
    'agent_stop', 'agent_workspaces', 'claude_usage',
  ])
})

test('opening a child creates a real conversation and pins its engine', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude', title: '子代理', model: 'claude-opus-5' })
  const childId = opened.childId
  assert.ok(bench.sessions.has(childId), 'the child is a real session')
  assert.equal(bench.claudeState.get(childId).mode, 'claude')
  assert.equal(bench.claudeState.get(childId).model, 'claude-opus-5')
  assert.equal(bench.claudeState.get(childId).permissionMode, 'manual')
  assert.match(opened.report, /Approvals go to: parent/)
})

test('a dsh child is pinned to dsh rather than inheriting the last engine choice', async () => {
  const bench = harnessBench()
  bench.services.ccmodeControl.setMode('anything', 'claude')
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  assert.equal(bench.claudeState.get(opened.childId).mode, 'dsh')
})

test('an unknown permission preset is refused before any conversation exists', async () => {
  const bench = harnessBench()
  await assert.rejects(
    () => bench.call('agent_open', { engine: 'dsh', permissionMode: 'nope' }),
    /unknown permission preset "nope"/,
  )
  assert.equal(bench.sessions.size, 1, 'no stray child was created')
})

test('sending reads back only what happened after the prompt', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const child = bench.sessions.get(opened.childId)
  child.push('assistant/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'earlier' }] } })

  const sent = await bench.call('agent_send', { childId: opened.childId, text: 'hello', wait: false })
  assert.deepEqual(bench.prompts.at(-1), { sessionId: opened.childId, mode: 'queue', text: 'hello' })

  child.push('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'later' }] } })
  child.push('turn/end', { turn: 1, reason: { kind: 'blocked' } })

  const read = await bench.call('agent_read', { childId: opened.childId })
  assert.match(read.report, /later/)
  assert.doesNotMatch(read.report, /earlier/)
  assert.match(read.report, /turn 1 done/)
  assert.ok(sent.report.length > 0)
})

test('dsh scaffolding stays out of the read unless it is asked for', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const child = bench.sessions.get(opened.childId)
  child.push('user/message', { content: [{ type: 'text', text: 'runtime context snapshot' }], source: { kind: 'plugin' } })

  const quiet = await bench.call('agent_read', { childId: opened.childId, sinceSeq: -1 })
  assert.doesNotMatch(quiet.report, /runtime context snapshot/)
  const loud = await bench.call('agent_read', { childId: opened.childId, sinceSeq: -1, context: true })
  assert.match(loud.report, /runtime context snapshot/)
})

test("a child's permission question is answered by its parent", async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const listener = bench.listeners['approval/request'][0]
  let fellThrough = false
  const decision = listener(
    { agent: { session: bench.sessions.get(opened.childId) }, toolName: 'write', reason: 'escalate' },
    () => { fellThrough = true; return Promise.resolve('unavailable') },
  )
  assert.equal(fellThrough, false, 'the human answerer never saw it')
  const listed = await bench.call('agent_list', {})
  assert.match(listed.report, /WAITING ON YOU: req-1 \(write/)
  await bench.call('agent_approve', { requestId: 'req-1', decision: 'allow' })
  assert.equal(await decision, 'allowed-once')
})

test('a question from an unmanaged conversation falls through to the human', () => {
  const bench = harnessBench()
  const listener = bench.listeners['approval/request'][0]
  let fellThrough = false
  listener({ agent: { session: bench.sessions.get('parent-1') }, toolName: 'bash' }, () => { fellThrough = true; return Promise.resolve('allowed-once') })
  assert.equal(fellThrough, true)
})

test('standing allow and deny answer without parking anything', async () => {
  const bench = harnessBench()
  const listener = bench.listeners['approval/request'][0]
  const allowed = await bench.call('agent_open', { engine: 'dsh', approvals: 'allow' })
  const denied = await bench.call('agent_open', { engine: 'dsh', approvals: 'deny' })
  assert.equal(await listener({ agent: { session: bench.sessions.get(allowed.childId) }, toolName: 'bash' }, () => 'x'), 'allowed-once')
  assert.equal(await listener({ agent: { session: bench.sessions.get(denied.childId) }, toolName: 'bash' }, () => 'x'), 'rejected')
})

test('reconfiguring a child moves the knobs it actually has', async () => {
  const bench = harnessBench()
  const claude = await bench.call('agent_open', { engine: 'claude' })
  const tuned = await bench.call('agent_config', { childId: claude.childId, model: 'claude-sonnet-5', permissionMode: 'acceptEdits' })
  assert.match(tuned.report, /model=claude-sonnet-5/)
  assert.equal(bench.claudeState.get(claude.childId).permissionMode, 'acceptEdits')
  await assert.rejects(() => bench.call('agent_config', { childId: claude.childId, permissionMode: 'read-only' }), /unknown Claude permission mode/)
  const dsh = await bench.call('agent_open', { engine: 'dsh' })
  const preset = await bench.call('agent_config', { childId: dsh.childId, permissionMode: 'read-only', model: 'deepseek-reasoner' })
  assert.match(preset.report, /permissionPreset=read-only/)
  assert.match(preset.report, /model=deepseek-official\/deepseek-reasoner/)
})

test('a slash command runs in a dsh child instead of reaching its model', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const promptsBefore = bench.prompts.length
  const ran = await bench.call('agent_send', { childId: opened.childId, text: '/permission read-only' })
  assert.equal(bench.prompts.length, promptsBefore, 'the model was never asked')
  assert.match(ran.report, /\/permission in .*: success — preset read-only/)
  await bench.call('agent_send', { childId: opened.childId, text: '/not-a-command', wait: false })
  assert.equal(bench.prompts.length, promptsBefore + 1)
})

test('a slash command in a Claude child belongs to Claude', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude' })
  const commandsBefore = bench.commandLines.length
  await bench.call('agent_send', { childId: opened.childId, text: '/context', wait: false })
  assert.equal(bench.commandLines.length, commandsBefore, "dsh's registry never saw it")
  assert.equal(bench.prompts.at(-1).text, '/context')
})

test('stopping interrupts the turn, closing also stops managing the conversation', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_stop', { childId: opened.childId })
  assert.deepEqual(bench.cancelled, [opened.childId])
  assert.match((await bench.call('agent_list', {})).report, new RegExp(opened.childId))
  await bench.call('agent_stop', { childId: opened.childId, action: 'close' })
  assert.match((await bench.call('agent_list', {})).report, /No child conversations open/)
  assert.ok(bench.sessions.has(opened.childId), 'the conversation itself survives for a human')
})

test('a parent only sees the children it opened', async () => {
  const bench = harnessBench()
  bench.makeSession('parent-2', '/work')
  await bench.call('agent_open', { engine: 'dsh' }, 'parent-1')
  await bench.call('agent_open', { engine: 'dsh' }, 'parent-2')
  assert.equal((await bench.call('agent_list', {}, 'parent-1')).children.length, 1)
  assert.equal((await bench.call('agent_list', { all: true }, 'parent-1')).children.length, 2)
})

test('the half waits for the API gateway instead of idling when it applies first', async () => {
  const bench = harnessBench({ gateway: 'late' })
  assert.deepEqual(bench.registered, [], 'nothing is registered against a gateway that is not there yet')
  bench.openGateway()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(bench.registered.length, 10, 'the tools appear once the gateway does')
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  assert.ok(bench.sessions.has(opened.childId))
})

// ---------- notification / waking the parent ----------

test('a child that finishes after the parent let go wakes the parent', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  const before = bench.prompts.length
  bench.sessions.get(opened.childId).push('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'all done' }] } })
  endTurn(bench, opened.childId)
  await settled()
  const notice = bench.prompts.at(-1)
  assert.equal(bench.prompts.length, before + 1, 'exactly one message went to the parent')
  assert.equal(notice.sessionId, 'parent-1')
  assert.match(notice.text, /子对话通知/)
  assert.match(notice.text, /all done/)
})

test('a child the parent is still waiting on does not also wake it', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const sending = bench.call('agent_send', { childId: opened.childId, text: 'go', timeoutSeconds: 5 })
  await new Promise(resolve => setTimeout(resolve, 5))
  endTurn(bench, opened.childId)
  await sending
  const before = bench.prompts.length
  await settled()
  assert.equal(bench.prompts.length, before, 'the synchronous return WAS the notification')
})

test('children finishing together cost the parent one turn, not one each', async () => {
  const bench = harnessBench()
  const first = await bench.call('agent_open', { engine: 'dsh' })
  const second = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: first.childId, text: 'go', wait: false })
  await bench.call('agent_send', { childId: second.childId, text: 'go', wait: false })
  const before = bench.prompts.length
  endTurn(bench, first.childId)
  endTurn(bench, second.childId)
  await settled()
  assert.equal(bench.prompts.length, before + 1)
  const notice = bench.prompts.at(-1)
  assert.match(notice.text, new RegExp(first.childId))
  assert.match(notice.text, new RegExp(second.childId))
})

test('an approval the parent is not waiting on wakes it too', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  const before = bench.prompts.length
  const listener = bench.listeners['approval/request'][0]
  const decision = listener({ agent: { session: bench.sessions.get(opened.childId) }, toolName: 'write', reason: 'escalate' }, () => Promise.resolve('unavailable'))
  await settled()
  const notice = bench.prompts.at(-1)
  assert.equal(bench.prompts.length, before + 1)
  assert.match(notice.text, /卡在一个权限请求上/)
  assert.match(notice.text, /req-1/)
  await bench.call('agent_approve', { requestId: 'req-1', decision: 'allow' })
  assert.equal(await decision, 'allowed-once')
})

test('notify: off leaves the parent alone', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', notify: 'off' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  const before = bench.prompts.length
  endTurn(bench, opened.childId)
  await settled()
  assert.equal(bench.prompts.length, before)
  const tuned = await bench.call('agent_config', { childId: opened.childId, notify: 'wake' })
  assert.match(tuned.report, /notify=wake/)
})

test('a parent dsh has unloaded IS woken to hear delegated news (the fix)', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  // dsh detached the idle parent while the child worked a long time.
  bench.sessions.delete('parent-1')
  const before = bench.prompts.length
  endTurn(bench, opened.childId)
  await settled()
  const notice = bench.prompts.at(-1)
  assert.equal(bench.prompts.length, before + 1, 'the delegator is woken, not left in the dark')
  assert.equal(notice.sessionId, 'parent-1')
  assert.equal(notice.mode, 'queue', 'an unloaded parent is woken with a fresh turn, not steered')
  assert.match(notice.text, /子对话通知/)
})

test('a notice is steered, so a parent mid-turn hears it without finishing first', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  bench.sessions.get('parent-1').push('turn/start', { turn: 9 })
  endTurn(bench, opened.childId)
  await settled()
  const notice = bench.prompts.at(-1)
  assert.equal(notice.sessionId, 'parent-1')
  assert.equal(notice.mode, 'steer')
})

test('a busy parent is told at once, without waiting out the merge window', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  bench.sessions.get('parent-1').push('turn/start', { turn: 9 })
  const before = bench.prompts.length
  endTurn(bench, opened.childId)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(bench.prompts.length, before + 1)
})

// ---------- questions routed to the parent (the ask fix) ----------

test('a dsh child question parks for the parent and agent_answer shapes the reply', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const listener = bench.listeners['userQuestions/request'][0]
  assert.ok(listener !== undefined, 'the question bridge installed')

  let fellThrough = false
  const answering = listener({
    agent: { session: bench.sessions.get(opened.childId) },
    questions: [{ id: 'q1', header: 'Deploy', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }], multiSelect: false }],
  }, () => { fellThrough = true; return Promise.resolve({ answers: [] }) })
  assert.equal(fellThrough, false, 'the human UI never saw the managed child question')

  const listed = await bench.call('agent_list', {})
  assert.match(listed.report, /WAITING ON YOU: req-1 \(question/)

  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['staging'] }] })
  const answer = await answering
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['staging'] }] })
})

test('declining a dsh child question rejects the ask rather than returning a malformed answer', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const listener = bench.listeners['userQuestions/request'][0]
  const answering = listener({
    agent: { session: bench.sessions.get(opened.childId) },
    questions: [{ id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }] }],
  }, () => Promise.resolve({ answers: [] }))
  // agent_approve deny on a question means "I decline to answer".
  await bench.call('agent_approve', { requestId: 'req-1', decision: 'deny' })
  await assert.rejects(() => answering, /did not answer/)
})

test('a Claude child question is routed to the parent via answerQuestion and keyed by question text', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude', approvals: 'parent' })
  const control = bench.control()
  assert.ok(typeof control.answerQuestion === 'function', 'the control surface exposes answerQuestion')

  const asking = control.answerQuestion(opened.childId, [
    { id: 'q1', header: 'Env', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }], multiSelect: false },
  ])
  // The parent sees it parked as a question.
  const listed = await bench.call('agent_list', {})
  assert.match(listed.report, /WAITING ON YOU: req-1 \(question/)

  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['prod'], custom: 'us-east only' }] })
  const result = await asking
  assert.equal(result.answered, true)
  assert.deepEqual(result.answers, { 'Which environment?': 'prod, us-east only' })
})

test('answerQuestion declines for a child the parent does not supervise', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude', approvals: 'human' })
  const result = await bench.control().answerQuestion(opened.childId, [{ id: 'q1', question: 'x', options: [] }])
  assert.deepEqual(result, { answered: false, answers: {} })
})

test('childInfo tells claude-in-dsh whether a session is a managed child', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude' })
  assert.deepEqual(bench.control().childInfo(opened.childId), { childId: opened.childId, parentId: 'parent-1', engine: 'claude', approvals: 'parent' })
  assert.equal(bench.control().childInfo('parent-1'), null)
})

// ---------- memory budget: at most N resident Claude processes ----------

test('starting a third Claude turn stops the least-recently-used idle Claude child', async () => {
  const bench = harnessBench()
  const a = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_send', { childId: a.childId, text: 'go', wait: false })
  endTurn(bench, a.childId)
  const b = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_send', { childId: b.childId, text: 'go', wait: false })
  endTurn(bench, b.childId)
  const c = await bench.call('agent_open', { engine: 'claude' })

  assert.deepEqual(bench.stopped, [], 'nothing evicted while under the budget')
  await bench.call('agent_send', { childId: c.childId, text: 'go', wait: false })
  assert.deepEqual(bench.stopped, [a.childId], 'the oldest idle Claude child was stopped to make room')
})

test('a mid-turn Claude child is never evicted for the budget', async () => {
  const bench = harnessBench()
  const a = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_send', { childId: a.childId, text: 'go', wait: false }) // a stays mid-turn (no endTurn)
  const b = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_send', { childId: b.childId, text: 'go', wait: false }) // b stays mid-turn
  const c = await bench.call('agent_open', { engine: 'claude' })
  await bench.call('agent_send', { childId: c.childId, text: 'go', wait: false })
  assert.deepEqual(bench.stopped, [], 'no idle child existed to evict; running ones are left alone')
})

// ---------- A2A task lifecycle ----------

test('the A2A endpoint serves an agent card and a task that walks working → input-required → completed', async () => {
  const bench = harnessBench()
  const endpoint = await bench.control().endpoint('parent-1')
  const token = endpoint.token

  const card = await bench.wire('/dsh-agent-mesh/a2a', { method: 'GET', urlPath: 'agent-card/parent-1', token })
  assert.equal(card.status, 200)
  assert.equal(card.json().capabilities.pushNotifications, true)
  assert.ok(card.json().skills.some(skill => skill.id === 'agent_open'))

  // Open a child + first message through A2A message/send.
  const opened = await bench.wire('/dsh-agent-mesh/a2a', {
    token, urlPath: 'parent-1',
    bodyObj: { jsonrpc: '2.0', id: 1, method: 'message/send', params: {
      message: { role: 'user', parts: [{ kind: 'text', text: 'do the thing' }], metadata: { op: 'agent_open', arguments: { engine: 'dsh', prompt: 'do the thing', wait: false } } } },
    },
  })
  const task = opened.json().result
  assert.equal(task.kind, 'task')
  assert.equal(task.status.state, 'working')
  const childId = task.contextId

  // The child asks a permission question → the task goes input-required.
  const listener = bench.listeners['approval/request'][0]
  listener({ agent: { session: bench.sessions.get(childId) }, toolName: 'write', reason: 'escalate' }, () => Promise.resolve('unavailable'))
  const blocked = await bench.wire('/dsh-agent-mesh/a2a', { token, bodyObj: { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.id } } })
  assert.equal(blocked.json().result.status.state, 'input-required')

  // Answering through message/send with a taskId resumes it to working.
  await bench.wire('/dsh-agent-mesh/a2a', { token, urlPath: 'parent-1', bodyObj: { jsonrpc: '2.0', id: 3, method: 'message/send', params: {
    message: { taskId: task.id, role: 'user', parts: [{ kind: 'text', text: 'allow' }], metadata: { decision: 'allow' } } } } })
  const resumed = await bench.wire('/dsh-agent-mesh/a2a', { token, bodyObj: { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: task.id } } })
  assert.equal(resumed.json().result.status.state, 'working')

  // Turn ends → completed, with the child's last message as an artifact.
  bench.sessions.get(childId).push('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'finished it' }] } })
  endTurn(bench, childId)
  const done = await bench.wire('/dsh-agent-mesh/a2a', { token, bodyObj: { jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { id: task.id } } })
  assert.equal(done.json().result.status.state, 'completed')
  assert.ok(done.json().result.artifacts.some(a => a.parts.some(p => p.text === 'finished it')))
})

test('A2A pushNotificationConfig round-trips and the MCP endpoint still serves tools', async () => {
  const bench = harnessBench()
  const endpoint = await bench.control().endpoint('parent-1')
  const token = endpoint.token

  const set = await bench.wire('/dsh-agent-mesh/a2a', { token, bodyObj: { jsonrpc: '2.0', id: 1, method: 'tasks/pushNotificationConfig/set', params: { pushNotificationConfig: { url: 'http://127.0.0.1:9/hook', token: 'abc' } } } })
  assert.equal(set.json().result.pushNotificationConfig.url, 'http://127.0.0.1:9/hook')

  const list = await bench.wire('/dsh-agent-mesh/mcp', { token, bodyObj: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })
  assert.ok(list.json().result.tools.some(t => t.name === 'agent_open'))
})

// ---------- usage ----------

function usageSnapshotFixture(fiveHourPercent, minutesToReset) {
  return {
    official: true, subscription: 'max', rateLimitTier: 'default',
    windows: [
      { id: 'five_hour', label: '5h', utilization: fiveHourPercent, resetsAt: new Date(Date.now() + minutesToReset * 60000).toISOString() },
      { id: 'seven_day', label: '7d', utilization: 61.4, resetsAt: new Date(Date.now() + 76 * 3600000).toISOString() },
    ],
    fetchedAt: Date.now(),
  }
}

test('claude_usage reports the 5h window as a number and a countdown', async () => {
  const bench = harnessBench({ usage: usageSnapshotFixture(42.4, 133) })
  const answer = await bench.call('claude_usage', {})
  assert.equal(answer.official, true)
  const five = answer.windows.find(window => window.id === 'five_hour')
  assert.equal(five.usedPercent, 42)
  assert.equal(five.remainingPercent, 58)
  assert.ok(Math.abs(five.resetsInMinutes - 133) <= 1)
  assert.match(answer.report, /5h: 42% used/)
  assert.match(answer.report, /resets in 2h13m/)
})

test('claude_usage answers from the cache unless asked to refresh', async () => {
  const bench = harnessBench({ usage: usageSnapshotFixture(10, 60) })
  await bench.call('claude_usage', {})
  await bench.call('claude_usage', { refresh: true })
  assert.deepEqual(bench.usageCalls, [false, true])
})

test('claude_usage explains a gateway instead of reporting a wrong number', async () => {
  const bench = harnessBench({ usage: { official: false, reason: 'gateway-override' } })
  const answer = await bench.call('claude_usage', {})
  assert.equal(answer.official, false)
  assert.equal(answer.windows, undefined)
  assert.match(answer.report, /gateway/)
})

// ---------- send defaults: cut in (steer) when running, queue when idle ----------

test('agent_send with no mode cuts in (steer) while the child is mid-turn', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const child = bench.sessions.get(opened.childId)
  child.push('turn/start', { turn: 1 })   // child is running
  await bench.call('agent_send', { childId: opened.childId, text: 'cut in', wait: false })
  assert.equal(bench.prompts.at(-1).mode, 'steer', 'a running child is steered by default (插队)')
})

test('agent_send with mode: queue waits behind a running child', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  const child = bench.sessions.get(opened.childId)
  child.push('turn/start', { turn: 1 })
  await bench.call('agent_send', { childId: opened.childId, text: 'behind', wait: false, mode: 'queue' })
  assert.equal(bench.prompts.at(-1).mode, 'queue')
})

test('agent_send with auto on an idle child starts a new turn (queue)', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: 'start', wait: false, mode: 'auto' })
  assert.equal(bench.prompts.at(-1).mode, 'queue', 'an idle child has no running turn to cut into')
})

// ---------- question routing through the wrapped userQuestions provider ----------

test('a managed child question through the userQuestions provider parks for the parent', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const provider = bench.services.userQuestions.provider   // the wrapped slot
  const asking = provider.ask({
    agent: { id: opened.childId },
    questions: [{ id: 'q1', header: 'Deploy', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }], multiSelect: false }],
  })

  const listed = await bench.call('agent_list', {})
  assert.match(listed.report, /WAITING ON YOU: req-1 \(question/)
  // statusOf must not carry callId:undefined for a question (lossless JSON only).
  const childStatus = listed.children.find(entry => entry.childId === opened.childId)
  assert.ok(childStatus.awaiting[0], 'the parked question is reported')
  assert.equal(Object.prototype.hasOwnProperty.call(childStatus.awaiting[0], 'callId'), false)

  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['staging'] }] })
  const answer = await asking
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['staging'] }] })
})

test('an unmanaged conversation question falls through to the human provider', async () => {
  const bench = harnessBench()
  const provider = bench.services.userQuestions.provider   // the wrapped slot
  const human = await provider.ask({
    agent: { id: 'parent-1' },   // parent-1 is not a managed child
    questions: [{ id: 'q1', question: 'not managed?' }],
  })
  assert.deepEqual(human, { answers: [] })
})

// ---------- dsh 0.1.2：apiProxy 拆成了各域控制器 ----------
//
// 0.1.2 之后 ctx.apiProxy 不存在了，插件原地报
// "no apiProxy in this deployment — conversations cannot open conversations"，
// 一个子对话都开不出来。这组用例跑的是同样的九次调用，只不过对面换成新服务。

test('0.1.2：没有 apiProxy 也能开出真对话', async () => {
  const bench = harnessBench({ dsh: '0.1.2' })
  assert.equal(bench.services.apiProxy, undefined, '这个部署里就是没有 apiProxy')
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  assert.ok(bench.sessions.has(opened.childId), '会话要真的建出来')
})

test('0.1.2：a2a 一来一回都走得通', async () => {
  const bench = harnessBench({ dsh: '0.1.2' })
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  await bench.call('agent_send', { childId: opened.childId, text: '干活', wait: false })
  assert.equal(bench.prompts.at(-1).text, '干活')
  // 读回来走的是 host 侧的日志，不是 0.1.2 里需要 follow 游标的 page()
  const read = await bench.call('agent_read', { childId: opened.childId })
  assert.ok(JSON.stringify(read).includes('干活'), '发出去的话要能读回来')
})

test('0.1.2：停止和改名也照旧', async () => {
  const bench = harnessBench({ dsh: '0.1.2' })
  const opened = await bench.call('agent_open', { engine: 'dsh', title: '起个名' })
  await bench.call('agent_send', { childId: opened.childId, text: 'go', wait: false })
  await bench.call('agent_stop', { childId: opened.childId, mode: 'cancel' })
  assert.ok(bench.cancelled.includes(opened.childId))
})

// ---------- 读已有项目 / 指定项目 ----------

test('看得见 dsh 侧边栏里已有的项目', async () => {
  const bench = harnessBench()
  const listed = await bench.call('agent_workspaces', {})
  assert.deepEqual(listed.workspaces, [
    { workspaceId: 'ws-1', title: undefined, path: '/work', sessions: 1 },
  ])
})

test('可以直接开进一个已有项目，不用重新拼路径', async () => {
  const bench = harnessBench({ dsh: '0.1.2' })
  const listed = await bench.call('agent_workspaces', {})
  const target = listed.workspaces[0].workspaceId
  const opened = await bench.call('agent_open', { engine: 'dsh', workspaceId: target })
  assert.ok(bench.sessions.has(opened.childId))
})

test('指向一个不存在的项目要说清楚，而不是默默开在别处', async () => {
  const bench = harnessBench({ dsh: '0.1.2' })
  await assert.rejects(
    () => bench.call('agent_open', { engine: 'dsh', workspaceId: 'ws-nope' }),
    /no project with id ws-nope/)
})

test('访问器之外不再直接读 session.events', () => {
  // dsh 0.1.2 把日志改成私有，直接读会在第一次用到子对话时抛
  // "events is not iterable"——而它抛在 agent_open 里，看起来像开不出对话。
  const source = fs.readFileSync(new URL('../src/mesh.dynamic.js', import.meta.url), 'utf8')
  const accessor = source.slice(source.indexOf('function sessionEvents('))
  const body = accessor.slice(0, accessor.indexOf('\n    }') + 6)
  const outside = source.replace(body, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  // `page.events` 是 API 响应，不是 Session——只看 session.events
  const leaks = outside.match(/\bsession\.events/g) || []
  assert.deepEqual(leaks, [], '还有地方直接读 session.events，在 dsh 0.1.2 上会炸')
})

// ---------- 指定子对话跑在哪台机器上 ----------
//
// 一个 Claude 子对话本来只能继承「上一次人选的目标」——一台机器时够用，
// 想要「这个跑容器、那个跑本机」就不行了。

test('可以指定子对话在哪台机器上跑', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', {
    engine: 'claude', remote: 'worker', remoteCwd: '/srv/app',
  })
  assert.deepEqual(bench.remoteCalls, [
    { id: opened.childId, remote: 'worker', remoteCwd: '/srv/app' },
  ])
})

test('不指定就不去碰它，继承部署的默认目标', async () => {
  const bench = harnessBench()
  await bench.call('agent_open', { engine: 'claude' })
  assert.deepEqual(bench.remoteCalls, [], '没说要换机器，就不该动这个会话的目标')
})

test('只给目录不换机器也成立', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'claude', remoteCwd: '/srv/only-dir' })
  assert.deepEqual(bench.remoteCalls, [
    { id: opened.childId, remote: undefined, remoteCwd: '/srv/only-dir' },
  ])
})

test('dsh 引擎的子对话不碰这两个参数', async () => {
  const bench = harnessBench()
  await bench.call('agent_open', { engine: 'dsh', remote: 'worker' })
  assert.deepEqual(bench.remoteCalls, [], '目标是 Claude 引擎的概念')
})

// dsh 在 0.1.1-rc 与 0.1.2 之间把这个瀑布改了名（驼峰 → 连字符）。
// 之前这里只测驼峰——而代码用的也是驼峰，等于拿代码验自己：真实 dsh 发的
// 是哪个名字从来没被覆盖过。于是 0.1.2 上桥根本没挂上，子对话的提问直接
// 落到人类卡片，父对话永远收不到。
test('提问桥挂在 dsh 真正发的那个事件名上', async () => {
  const bench = harnessBench()
  await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  assert.ok(bench.listeners['user-questions/request'][0] !== undefined,
    '0.1.2 发的是 user-questions/request（连字符）——没挂上就等于没有这个功能')
  assert.ok(bench.listeners['userQuestions/request'][0] !== undefined,
    '旧名字也要继续听，一台机器升级不等于所有部署都升级')
})

test('走连字符事件时，子对话的提问同样park给父对话', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const listener = bench.listeners['user-questions/request'][0]

  let fellThrough = false
  const answering = listener({
    agent: { session: bench.sessions.get(opened.childId) },
    questions: [{ id: 'q1', header: 'Env', question: '哪个环境？', options: [{ label: 'staging' }] }],
  }, () => { fellThrough = true; return Promise.resolve({ answers: [] }) })
  assert.equal(fellThrough, false, '人类卡片不该看到被托管子对话的提问')

  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['staging'] }] })
  assert.deepEqual(await answering, { answers: [{ id: 'q1', selected: ['staging'] }] })
})

test('载荷只带 agent.id 时也认得出是哪个子对话', async () => {
  // 0.1.2 的 emit 是 { ...request, agent }，agent 上不一定挂着 session。
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const listener = bench.listeners['user-questions/request'][0]
  let fellThrough = false
  listener({
    agent: { id: opened.childId },
    questions: [{ id: 'q1', header: 'H', question: '?', options: [{ label: 'a' }] }],
  }, () => { fellThrough = true; return Promise.resolve({ answers: [] }) })
  assert.equal(fellThrough, false, '只有 id 也该认出来，否则又是静默失效')
})

// token 曾经是「先随机、再被注册表替换」。插件重载得很频繁（实测一次 dsh
// 运行里激活了 19 次），于是每次激活都短暂持有一把自己的随机 token：
// 用某一次的 token 启动的 Claude 进程，撞上另一次的校验就永远 401——
// 症状只是那个对话里 mesh 工具悄悄消失了。
test('token 从注册表来，不是每次激活随机一把', () => {
  const source = fs.readFileSync(new URL('../src/mesh.dynamic.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /let wireToken = randomToken\(\)/,
    '不能以随机值开始服务——那样每次重载都会把在跑的子对话踢掉')
  assert.match(source, /let wireToken = REMOTE_TOKEN/,
    '起点应是环境变量（没有则为空），真正的值由注册表填')
})

test('还没读到 token 时明确答 503，而不是拿随机值去比', () => {
  const source = fs.readFileSync(new URL('../src/mesh.dynamic.js', import.meta.url), 'utf8')
  const guard = source.indexOf("if (wireToken.length === 0) {")
  const compare = source.indexOf("if (authorization !== 'Bearer ' + wireToken)")
  assert.ok(guard !== -1 && guard < compare,
    '未就绪的判断必须在比对之前——否则空 token 会把所有请求都判成 401')
})

// ---------- 插进正在跑的那一轮，可能根本没被读到 ----------
//
// 主对话在跑的时候，子对话的提问是 steer 进那一轮的。steer 会输给一个竞态：
// 「在跑」是看日志判断的，等 dsh 真的处理这条 prompt 时那一轮可能已经结束，
// 而一条 next-step 消息在没有 turn 的时候没人读。子对话于是永远卡在一个
// 「已经通知过一次、但那一次落在了一轮已经结束的对话里」的提问上。

/** 主对话自己那一轮结束时 dsh 追加的 turn/end。 */
function endParentTurn(bench, parentId = 'parent-1') {
  const session = bench.sessions.get(parentId)
  session.push('turn/end', { turn: 9, reason: { kind: 'completed' } })
  for (const listener of bench.listeners['session/event'] ?? []) listener(session, session.events.at(-1))
}

function askFrom(bench, childId) {
  const listener = bench.listeners['userQuestions/request'][0]
  return listener({
    agent: { session: bench.sessions.get(childId) },
    questions: [{ id: 'q1', header: 'Env', question: '选哪个环境？', options: [{ label: 'staging' }, { label: 'prod' }] }],
  }, () => Promise.resolve({ answers: [] }))
}

test('插进去的提问那一轮结束还没被回答，就用新的一轮再问一次', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  bench.sessions.get('parent-1').push('turn/start', { turn: 9 })

  const answering = askFrom(bench, opened.childId)
  await settled()
  assert.equal(bench.prompts.at(-1).mode, 'steer', '主对话在跑，先插队试一次')

  const before = bench.prompts.length
  endParentTurn(bench)
  await settled()
  assert.equal(bench.prompts.length, before + 1, '问题还挂着，就得再问一次')
  assert.equal(bench.prompts.at(-1).mode, 'queue', '这次要用新的一轮——插队会再丢一次')
  assert.match(bench.prompts.at(-1).text, /req-1/)

  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['prod'] }] })
  assert.deepEqual(await answering, { answers: [{ id: 'q1', selected: ['prod'] }] })
})

test('已经回答过的提问，主对话那一轮结束时不会再被打扰', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  bench.sessions.get('parent-1').push('turn/start', { turn: 9 })
  const answering = askFrom(bench, opened.childId)
  await settled()
  await bench.call('agent_answer', { requestId: 'req-1', answers: [{ id: 'q1', selected: ['prod'] }] })
  await answering

  const before = bench.prompts.length
  endParentTurn(bench)
  await settled()
  assert.equal(bench.prompts.length, before, '答完了就没什么可提醒的了')
})

test('只提醒一次：主对话忽略第二次就是它的决定，第三次只是白烧一轮', async () => {
  const bench = harnessBench()
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  bench.sessions.get('parent-1').push('turn/start', { turn: 9 })
  askFrom(bench, opened.childId)
  await settled()

  endParentTurn(bench)
  await settled()
  const afterFirst = bench.prompts.length
  endParentTurn(bench)
  await settled()
  assert.equal(bench.prompts.length, afterFirst, '提醒过一次就够了')
})

test('投递失败的通知会自己重试，而不是烂在队列里等下一个事件', async () => {
  let fail = true
  const bench = harnessBench({
    onPrompt: ({ sessionId }) => {
      if (fail && sessionId === 'parent-1') { fail = false; throw new Error('这一轮刚好结束了') }
    },
  })
  const opened = await bench.call('agent_open', { engine: 'dsh', approvals: 'parent' })
  const before = bench.prompts.length
  askFrom(bench, opened.childId)
  await settled()
  await settled()
  const notices = bench.prompts.slice(before).filter((p) => p.sessionId === 'parent-1')
  assert.equal(notices.length, 1, '第一次投递抛了，重试必须把它送到')
  assert.match(notices[0].text, /req-1/)
})

test('被挂起的子对话是停着的，它的通知不排在合并窗口后面', () => {
  const source = fs.readFileSync(path.join(root, 'src/mesh.dynamic.js'), 'utf8')
  const park = source.slice(source.indexOf('function park(child, request)'))
  const call = park.slice(0, park.indexOf('a2aOnParked'))
  assert.match(call, /\), true\)/, 'park 的通知必须标成紧急，否则一个被卡住的子对话要等满合并窗口')
  assert.match(source, /urgent === true \? 250 : 3000/, '紧急通知用更短的窗口')
})

// 等网关这件事没有「等够了」这一说。以前是等 60 次就永久放弃：整个 dsh 运行期
// 里没有工具、没有 MCP 路由、没有审批桥，主对话就是开不出子对话，日志里只有一行
// 「cannot open conversations」。60 秒听着很宽裕，直到机器忙起来——那台 Mac 并行
// 跑着十个 rustc、负载 80，dsh 光启动就要好几分钟，插件早就退场了。
test('网关来得再晚也等：过了快轮询窗口之后，工具依然会挂上', async () => {
  const bench = harnessBench({ gateway: 'late' })
  assert.deepEqual(bench.registered, [], '网关没来之前什么都不注册')
  // 撑过 60 次快轮询（测试里每次 20ms），也就是老代码放弃的那个点。
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.deepEqual(bench.registered, [], '还没来就还是什么都没有——但不该是「放弃了」')
  bench.openGateway()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(bench.registered.length, 10, '网关一出现，工具就该挂上——哪怕它迟到了很久')
  const opened = await bench.call('agent_open', { engine: 'dsh' })
  assert.ok(bench.sessions.has(opened.childId), '迟到的网关一样能开出子对话')
})
