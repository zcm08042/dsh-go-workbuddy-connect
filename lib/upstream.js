// WorkBuddy upstream access for dsh-go-workbuddy-connect.
//
// Protocol follows the community plugin `dsh-connect-workbuddy`:
//   - browser sign-in via /v2/plugin/auth/state + /v2/plugin/auth/token
//   - refresh via /v2/plugin/auth/token/refresh
//   - model calls via /v2/chat/completions (SSE), billed to the user's own
//     WorkBuddy/CodeBuddy account
//   - read-only credits via /v2/billing/meter/get-user-resource
//
// This is a non-official integration. Endpoints and headers can change.

import { randomUUID } from 'node:crypto'
import {
  clearCredential,
  deviceHeaders,
  readCredential,
  saveCredential,
} from './store.js'

const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const CN_CHAT_BASE = 'https://copilot.tencent.com'
const GLOBAL_BASE = 'https://www.workbuddy.ai'
const GLOBAL_ALT_BASE = 'https://www.codebuddy.ai'
const API_PREFIX = '/v2/plugin'

const CLIENT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
const APP_UA = 'WorkBuddy/5.8.3'
const JSON_TIMEOUT_MS = 30_000

export function regionBase(region, kind = 'billing', domain = '') {
  const normalized = typeof domain === 'string' ? domain.toLowerCase() : ''
  if (region === 'global' || normalized.includes('workbuddy.ai') || normalized.includes('codebuddy.ai')) {
    const base = normalized.includes('codebuddy.ai') ? GLOBAL_ALT_BASE : GLOBAL_BASE
    return base
  }
  return kind === 'chat' ? CN_CHAT_BASE : CN_BILLING_BASE
}

function originOf(base) {
  return base.replace(/\/+$/, '')
}

function commonHeaders(base) {
  const origin = originOf(base)
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

function attributionHeaders() {
  return {
    'X-Product': 'WorkBuddy',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.8.3',
  }
}

function identityHeaders(credential, extra = {}) {
  return {
    ...(typeof credential?.uid === 'string' && credential.uid !== ''
      ? { 'X-User-Id': credential.uid }
      : { 'X-No-User-Id': '1' }),
    ...(typeof credential?.enterpriseId === 'string' && credential.enterpriseId !== ''
      ? { 'X-Enterprise-Id': credential.enterpriseId }
      : { 'X-No-Enterprise-Id': '1' }),
    ...(typeof credential?.domain === 'string' && credential.domain !== ''
      ? { 'X-Domain': credential.domain }
      : { 'X-No-Department-Info': '1' }),
    ...extra,
  }
}

function conversationHeaders() {
  const requestId = randomUUID()
  const messageId = randomUUID()
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': requestId,
    'X-Root-Request-ID': requestId,
    'X-Conversation-Message-ID': messageId,
  }
}

async function readEnvelope(response) {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // Fall through with a readable snippet.
  }
  return { code: -1, message: text.slice(0, 300) }
}

function envelopeData(envelope) {
  const data = envelope?.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function expiryMs(source, absoluteKeys, ttlKeys) {
  for (const key of absoluteKeys) {
    const raw = source?.[key]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  }
  for (const key of ttlKeys) {
    const raw = source?.[key]
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return Date.now() + value * 1000
  }
  return 0
}

/** Display-only identity claims from an unsigned JWT payload. */
function jwtIdentity(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length < 2) return {}
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return {}
    return {
      uid: firstString(payload, ['sub', 'Sub', 'uid', 'Uid']),
      nickname: firstString(payload, ['nickname', 'NickName', 'preferred_username', 'preferredUsername']),
      uin: firstString(payload, ['uin', 'Uin']),
      enterpriseId: firstString(payload, ['enterpriseId', 'EnterpriseId']),
    }
  } catch {
    return {}
  }
}

/** Step 1: ask the upstream for a state and a login URL. */
export async function startLogin(region = 'cn') {
  const base = regionBase(region, 'billing')
  const response = await fetch(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || (envelope.code !== 0 && envelope.code !== 200)) {
    throw new Error(`登录服务返回错误 (${response.status}): ${firstString(envelope, ['message', 'msg']) || 'unknown'}`)
  }
  const data = envelopeData(envelope)
  const state = firstString(data, ['state', 'State'])
  if (state === '') throw new Error('登录服务没有返回 state，请稍后重试')
  const authUrl = firstString(data, ['authUrl', 'auth_url', 'url', 'Url']) || `${base}/login?state=${encodeURIComponent(state)}`
  return { region, base, state, authUrl }
}

/** Step 2: exchange a completed browser login for credentials. */
export async function finishLogin(pending) {
  if (!pending?.state || !pending?.base) throw new Error('没有进行中的登录，请先开始登录')
  const response = await fetch(`${pending.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(pending.state)}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || (envelope.code !== 0 && envelope.code !== 200)) {
    throw new Error('登录还没有完成，请在浏览器里完成扫码/登录后重试')
  }
  const data = envelopeData(envelope)
  const accessToken = firstString(data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') throw new Error('登录尚未完成，没有拿到访问令牌')

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    ...firstString(data, ['domain', 'Domain']) ? { 'X-Domain': firstString(data, ['domain', 'Domain']) } : {},
  }
  let profile = {}
  for (const path of [`${API_PREFIX}/account`, `${API_PREFIX}/login/account`]) {
    try {
      const res = await fetch(`${pending.base}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const doc = await readEnvelope(res)
      const candidate = envelopeData(doc)
      if (firstString(candidate, ['uid', 'Uid', 'userId', 'UserID']) !== '') {
        profile = candidate
        break
      }
    } catch {
      // Profile is display metadata; the token itself is enough to continue.
    }
  }
  const jwt = jwtIdentity(accessToken)
  const uid = firstString(profile, ['uid', 'Uid', 'userId', 'UserID']) || jwt.uid
  if (uid === '') throw new Error('无法识别这个账号，请稍后重新登录')

  const credential = {
    region: pending.region === 'global' ? 'global' : 'cn',
    accessToken,
    refreshToken: firstString(data, ['refreshToken', 'refresh_token', 'RefreshToken']),
    expiresAtMs: expiryMs(data, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']),
    domain: firstString(data, ['domain', 'Domain']) || firstString(profile, ['domain', 'Domain']),
    uid,
    nickname: firstString(profile, ['nickname', 'NickName']) || jwt.nickname,
    uin: firstString(profile, ['uin', 'Uin']) || jwt.uin,
    enterpriseId: firstString(profile, ['enterpriseId', 'EnterpriseId']) || jwt.enterpriseId,
    savedAt: Date.now(),
  }
  await saveCredential(credential)
  return credential
}

export async function logout() {
  await clearCredential()
}

/** Refresh an expired access token. The refresh token never goes on chat calls. */
async function refresh(credential) {
  const base = regionBase(credential.region, 'chat', credential.domain)
  const response = await fetch(`${base}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
      'User-Agent': CLIENT_UA,
      ...identityHeaders(credential),
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw new Error('登录已过期，请重新登录')
  const data = envelopeData(envelope)
  const accessToken = firstString(data, ['accessToken', 'access_token'])
  if (accessToken === '') throw new Error('刷新登录失败，请重新登录')
  const next = {
    ...credential,
    accessToken,
    refreshToken: firstString(data, ['refreshToken', 'refresh_token']) || credential.refreshToken,
    expiresAtMs: expiryMs(data, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']),
    savedAt: Date.now(),
  }
  await saveCredential(next)
  return next
}

/** Return a usable credential, refreshing when the access token looks stale. */
export async function usableCredential() {
  const credential = await readCredential()
  if (!credential) return null
  const stale = !credential.expiresAtMs || credential.expiresAtMs - Date.now() < 60_000
  if (!stale || !credential.refreshToken) return credential
  try {
    return await refresh(credential)
  } catch {
    return credential
  }
}

/** Read-only credit overview. Never auto-polls on its own. */
export async function fetchCredits() {
  const credential = await usableCredential()
  if (!credential) throw new Error('尚未登录 WorkBuddy')
  const base = regionBase(credential.region, 'billing', credential.domain)
  const now = new Date()
  const format = (date) => [
    date.getFullYear().toString().padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + ' ' + [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':')

  const response = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      ...commonHeaders(base),
      'Authorization': `Bearer ${credential.accessToken}`,
      ...identityHeaders(credential),
      ...attributionHeaders(),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: format(now),
      PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw new Error(`读取积分失败 (${response.status})`)
  const wrapper = envelopeData(envelope)
  const responseNode = wrapper.Response && typeof wrapper.Response === 'object' ? wrapper.Response : {}
  const dataNode = responseNode.Data && typeof responseNode.Data === 'object' ? responseNode.Data : {}
  const accounts = Array.isArray(dataNode.Accounts) ? dataNode.Accounts : []

  const precise = (row, key) => {
    const raw = row[`${key}Precise`] ?? row[key]
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }
  let total = 0
  let remain = 0
  const packages = []
  for (const row of accounts) {
    if (!row || typeof row !== 'object') continue
    const hasCycle = row.CycleCapacityRemain !== undefined || row.CycleCapacityRemainPrecise !== undefined
    const size = precise(row, 'CycleCapacitySize') || precise(row, 'CapacitySize')
    const left = hasCycle ? precise(row, 'CycleCapacityRemain') : precise(row, 'CapacityRemain')
    total += size
    remain += left
    packages.push({
      name: firstString(row, ['PackageName', 'Name', 'ProductName']) || '积分包',
      total: size,
      remain: left,
    })
  }
  return { total, remain, packages, account: credential.nickname || credential.uid }
}

/** Fetch the model directory; keep the raw ids for the chat tool. */
export async function fetchModels() {
  const credential = await usableCredential()
  if (!credential) throw new Error('尚未登录 WorkBuddy')
  const base = regionBase(credential.region, 'chat', credential.domain)
  const response = await fetch(`${base}/v3/config`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': APP_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Product': 'SaaS',
      ...identityHeaders(credential),
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw new Error(`读取模型列表失败 (${response.status})`)
  const data = envelopeData(envelope)
  const collect = (value, into) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) collect(item, into)
      return
    }
    const id = firstString(value, ['id', 'modelId', 'model', 'name'])
    if (id !== '' && (value.model !== undefined || value.modelId !== undefined || value.id !== undefined)) {
      into.set(id, firstString(value, ['displayName', 'label', 'name']) || id)
    }
    for (const [key, child] of Object.entries(value)) {
      if (['models', 'agents', 'modelPromotions', 'modelTiers', 'items', 'list'].includes(key)) collect(child, into)
    }
  }
  const map = new Map()
  collect(data, map)
  const models = Array.from(map, ([id, name]) => ({ id, name })).slice(0, 80)
  return models
}

/** Parse an SSE stream into a final answer and optional credit usage. */
async function readSse(response, signal) {
  let text = ''
  let credit = 0
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const handleEvent = (event) => {
    const lines = event.split(/\r?\n/)
    let payload = ''
    for (const line of lines) {
      if (line.startsWith('data:')) payload += line.slice(5).trimStart()
    }
    if (payload === '' || payload === '[DONE]') return payload === '[DONE]'
    try {
      const chunk = JSON.parse(payload)
      const delta = chunk?.choices?.[0]?.delta
      if (typeof delta?.content === 'string') text += delta.content
      if (typeof chunk?.usage?.credit === 'number') credit = chunk.usage.credit
      if (chunk?.error) throw new Error(firstString(chunk.error, ['message', 'msg']) || '上游返回错误')
    } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
    return false
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const body = await response.text()
    try {
      const parsed = JSON.parse(body)
      return {
        text: firstString(parsed?.choices?.[0]?.message, ['content']) || '',
        credit: Number(parsed?.usage?.credit) || 0,
      }
    } catch {
      throw new Error('上游没有返回可读内容')
    }
  }
  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (handleEvent(event)) return { text, credit }
      }
    }
    if (buffer.trim() !== '') handleEvent(buffer)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Ignore.
    }
  }
  return { text, credit }
}

/** One model call, billed to the user's WorkBuddy account. */
export async function chat({ prompt, model, system, maxTokens }, signal) {
  const credential = await usableCredential()
  if (!credential) throw new Error('尚未登录 WorkBuddy，请先在面板里登录')
  const base = regionBase(credential.region, 'chat', credential.domain)
  const messages = [
    { role: 'system', content: typeof system === 'string' && system.trim() !== ''
      ? system.trim()
      : 'You are a helpful assistant. Be concise and helpful.' },
    { role: 'user', content: prompt },
  ]
  const headers = {
    ...commonHeaders(base),
    'Authorization': `Bearer ${credential.accessToken}`,
    ...identityHeaders(credential),
    ...attributionHeaders(),
    ...conversationHeaders(),
    ...await deviceHeaders(credential),
  }
  const body = {
    model: typeof model === 'string' && model.trim() !== '' ? model.trim() : 'hy4',
    messages,
    stream: true,
  }
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens

  const response = await fetch(`${base}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`WorkBuddy 模型调用失败 (${response.status}): ${detail}`)
  }
  const result = await readSse(response, signal)
  return { ...result, model: body.model }
}
