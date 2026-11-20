// dsh-go-workbuddy-connect
//
// A phone-friendly WorkBuddy credits bridge for dsh-go. It follows the same
// protocol as the community plugin `dsh-connect-workbuddy`, but uses the
// browser sign-in flow (no desktop app, no encrypted credential import).
//
//   browser sign-in -> /v2/plugin/auth/state + /auth/token
//   model calls     -> /v2/chat/completions (SSE), billed to WorkBuddy
//   credits         -> /v2/billing/meter/get-user-resource (read only)
//
// The App only receives JSON views and effects; all plugin code runs in the
// engine. This is a non-official integration: upstream changes can break it.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  chat,
  fetchCredits,
  fetchModels,
  finishLogin,
  logout,
  startLogin,
  usableCredential,
} from './upstream.js'
import {
  clearPendingLogin,
  readPendingLogin,
  saveModels,
  savePendingLogin,
} from './store.js'
import {
  chatCard,
  creditsCard,
  loginCard,
  modelsCard,
  panelData,
  panelView,
  stripData,
  toolCard,
  words,
} from './views.js'

export const name = 'dsh-go-workbuddy-connect'
export const inject = ['tools']

const state = {
  credential: null,
  pending: null,
  credits: null,
  error: '',
}

const emitters = new Set()

function localeOf(event) {
  return typeof event?.locale === 'string' ? event.locale : 'zh'
}

function subscribe(emit, kind, locale) {
  const push = () => {
    try {
      emit(kind === 'panel' ? panelData(state, locale) : stripData(state, locale))
    } catch {
      // A closed panel must never break the plugin.
    }
  }
  push()
  emitters.add(push)
  return () => emitters.delete(push)
}

function notify() {
  for (const push of Array.from(emitters)) push()
}

async function hydrate() {
  state.credential = await usableCredential()
  state.pending = await readPendingLogin()
  state.error = ''
  state.credits = null
  if (state.credential) {
    try {
      state.credits = await fetchCredits()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
  }
}

const stringResult = { type: 'string', required: true }
const optionalModel = { type: 'string' }

export function apply(ctx) {
  // Hydrate once; failures stay in `state.error` and show in the panel.
  void hydrate().then(notify)

  ctx.tools.register(defineTool({
    name: 'workbuddy_login',
    description: 'Start WorkBuddy browser sign-in. Returns an https link the user must open. After signing in, call workbuddy_login_finish. Use this when the user wants to connect WorkBuddy credits.',
    parameters: {
      region: {
        type: 'string',
        enum: ['cn', 'global'],
        description: 'cn = mainland WorkBuddy/CodeBuddy, global = workbuddy.ai. Default cn.',
      },
      language: { type: 'string', enum: ['zh', 'en'], description: 'User language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authUrl: stringResult,
          region: { type: 'string', required: true },
          credential: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Open this link to sign in to WorkBuddy: ${value.authUrl}` }],
      presentationMeta: toolCard((_args, value) => loginCard(value, _args?.language)),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const region = args.region === 'global' ? 'global' : 'cn'
      const pending = await startLogin(region)
      await savePendingLogin(pending)
      state.pending = pending
      state.error = ''
      notify()
      return { authUrl: pending.authUrl, region, credential: Boolean(state.credential) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbuddy_login_finish',
    description: 'Finish a WorkBuddy browser sign-in after the user has confirmed in the browser. Call this only after workbuddy_login and the user says they finished.',
    parameters: {
      language: { type: 'string', enum: ['zh', 'en'], description: 'User language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          signedIn: { type: 'boolean', required: true },
          account: stringResult,
          credits: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.signedIn ? `Signed in as ${value.account}. Credits: ${value.credits || 'unknown'}.` : 'Sign-in not completed.' }],
      presentationMeta: toolCard((_args, value) => ({
        type: 'stack',
        title: 'WorkBuddy Sign-in',
        children: [
          { type: 'callout', text: value.signedIn ? words(_args?.language).loggedIn : words(_args?.language).notLoggedIn, tone: value.signedIn ? 'good' : 'warn' },
          { type: 'keyValue', items: [['Account', value.account]] },
        ],
      })),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    execute: async () => {
      const pending = state.pending || await readPendingLogin()
      const credential = await finishLogin(pending)
      await clearPendingLogin()
      state.pending = null
      state.credential = credential
      await hydrate()
      notify()
      return {
        signedIn: true,
        account: credential.nickname || credential.uid,
        credits: state.credits ? String(state.credits.remain) : '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbuddy_credits',
    description: 'Read the remaining WorkBuddy credits of the signed-in account. Read-only; never changes the account.',
    parameters: {
      language: { type: 'string', enum: ['zh', 'en'], description: 'User language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remain: { type: 'number', required: true },
          total: { type: 'number', required: true },
          account: stringResult,
          packages: { type: 'array', required: true, items: { type: 'object' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `WorkBuddy credits: ${value.remain} / ${value.total}` }],
      presentationMeta: toolCard((_args, value) => creditsCard(value, _args?.language)),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const result = await fetchCredits()
      state.credits = result
      state.error = ''
      notify()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbuddy_models',
    description: 'List model ids available to the signed-in WorkBuddy account. Call this before workbuddy_chat if the user did not name a model.',
    parameters: {
      language: { type: 'string', enum: ['zh', 'en'], description: 'User language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          models: { type: 'array', required: true, items: { type: 'object' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.models.slice(0, 30).map((m) => `${m.id} (${m.name})`).join(', ') }],
      presentationMeta: toolCard((_args, value) => modelsCard(value, _args?.language)),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const models = await fetchModels()
      await saveModels(models).catch(() => {})
      return { models }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbuddy_chat',
    description: 'Send one prompt to a WorkBuddy model. This spends credits from the user own WorkBuddy account. Use workbuddy_models first if no model id is known.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The user message to send to WorkBuddy.' },
      model: { ...optionalModel, description: 'WorkBuddy model id, e.g. hy4. Defaults to hy4.' },
      system: { type: 'string', description: 'Optional system instruction.' },
      maxTokens: { type: 'integer', description: 'Optional maximum output tokens.' },
      language: { type: 'string', enum: ['zh', 'en'], description: 'User language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: stringResult,
          model: stringResult,
          credit: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
      presentationMeta: toolCard((_args, value) => chatCard(value, _args?.language)),
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => chat(args, exec.signal),
  }))

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('workbuddy', {
      view: (scope, caps) => panelView(scope, caps),
      data: (scope, emit, caps) => subscribe(emit, 'panel', caps?.locale),
      actions: {
        login: (_scope, event) => ({
          pending: { label: words(localeOf(event)).login, timeoutMs: 30_000 },
          result: async (signal) => {
            if (signal?.aborted) return undefined
            const pending = await startLogin('cn')
            await savePendingLogin(pending)
            state.pending = pending
            state.error = ''
            notify()
            return { patch: panelData(state), toast: words(localeOf(event)).openLogin }
          },
        }),
        open: (_scope, event) => {
          const url = state.pending?.authUrl
          if (typeof url !== 'string' || !url.startsWith('https://')) {
            return { toast: words(localeOf(event)).noUrl }
          }
          return { link: url }
        },
        poll: (_scope, event) => ({
          pending: { label: words(localeOf(event)).checkLogin, timeoutMs: 30_000 },
          result: async (signal) => {
            if (signal?.aborted) return undefined
            const pending = state.pending || await readPendingLogin()
            const credential = await finishLogin(pending)
            await clearPendingLogin()
            state.pending = null
            state.credential = credential
            await hydrate()
            notify()
            return { patch: panelData(state), toast: words(localeOf(event)).loggedIn }
          },
        }),
        refresh: (_scope, event) => ({
          pending: { label: words(localeOf(event)).refresh, timeoutMs: 30_000 },
          result: async (signal) => {
            if (signal?.aborted) return undefined
            state.credits = await fetchCredits()
            state.error = ''
            notify()
            return { patch: panelData(state) }
          },
        }),
        logout: (_scope, event) => ({
          pending: { label: words(localeOf(event)).logout, timeoutMs: 30_000 },
          result: async (signal) => {
            if (signal?.aborted) return undefined
            await logout()
            state.credential = null
            state.credits = null
            state.error = ''
            notify()
            return { patch: panelData(state), toast: words(localeOf(event)).notLoggedIn }
          },
        }),
      },
    })

    ctx.dshGo.strip('wb-credits', (scope, emit, caps) => subscribe(emit, 'strip', caps?.locale))
  })
}
