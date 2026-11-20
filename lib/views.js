// Native views for dsh-go-workbuddy-connect. Pure JSON trees: the App draws
// them, the plugin never sends code to the App.

const WORDS = {
  zh: {
    status: '状态',
    account: '账号',
    remain: '剩余积分',
    total: '积分总额',
    packages: '积分包',
    login: '登录',
    openLogin: '打开登录页',
    checkLogin: '检查登录',
    refresh: '刷新积分',
    logout: '退出登录',
    hint: '登录后积分按官方倍率从你自己的 WorkBuddy 账号扣除。',
    notLoggedIn: '未登录',
    loggedIn: '已登录',
    pending: '登录中',
    noUrl: '请先点「登录」获取链接',
    toolHint: '在WorkBuddy面板里查看登录状态与积分。',
    model: '模型',
    credit: '本次积分',
  },
  en: {
    status: 'Status',
    account: 'Account',
    remain: 'Credits left',
    total: 'Total credits',
    packages: 'Packages',
    login: 'Sign in',
    openLogin: 'Open sign-in page',
    checkLogin: 'Check sign-in',
    refresh: 'Refresh credits',
    logout: 'Sign out',
    hint: 'After sign-in, calls are billed to your own WorkBuddy account.',
    notLoggedIn: 'Not signed in',
    loggedIn: 'Signed in',
    pending: 'Signing in',
    noUrl: 'Tap Sign in first',
    toolHint: 'Open the WorkBuddy panel to see sign-in status and credits.',
    model: 'Model',
    credit: 'Credits used',
  },
}

export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

const fmt = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** The native panel. All changing values are bindings into panel data. */
export function panelView(scope, caps) {
  const w = words(caps?.locale)
  return {
    type: 'stack',
    children: [
      { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
      {
        type: 'row',
        children: [
          { type: 'metric', label: w.remain, value: { $: 'data.remain' }, tone: 'good' },
          { type: 'metric', label: w.total, value: { $: 'data.total' } },
        ],
      },
      { type: 'progress', label: w.remain, value: { $: 'data.percent' }, max: 100 },
      { type: 'keyValue', items: [
        [w.status, { $: 'data.status' }],
        [w.account, { $: 'data.account' }],
      ] },
      { type: 'text', text: w.hint, tone: 'muted' },
      {
        type: 'actions',
        items: [
          { label: w.login, action: 'login', icon: 'link', style: 'primary' },
          { label: w.openLogin, action: 'open', icon: 'external' },
          { label: w.checkLogin, action: 'poll', icon: 'refresh' },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: w.refresh, action: 'refresh', icon: 'coin' },
          { label: w.logout, action: 'logout', icon: 'remove' },
        ],
      },
      { type: 'text', text: { $: 'data.error' }, tone: 'warn' },
      { type: 'list', items: { $: 'data.packages' } },
    ],
  }
}

export function panelData(snapshot, locale) {
  const w = words(locale)
  const status = snapshot.credential ? w.loggedIn : (snapshot.pending ? w.pending : w.notLoggedIn)
  const total = Number(snapshot.credits?.total) || 0
  const remain = Number(snapshot.credits?.remain) || 0
  return {
    status,
    statusText: snapshot.credential ? w.loggedIn : `${w.status}: ${w.notLoggedIn}`,
    statusTone: snapshot.credential ? 'good' : 'info',
    account: snapshot.credential?.nickname || snapshot.credential?.uid || '—',
    total: fmt(total),
    remain: fmt(remain),
    percent: total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 100))) : 0,
    error: snapshot.error || '',
    url: snapshot.pending?.authUrl || '',
    packages: (snapshot.credits?.packages || []).map((item) => ({
      title: item.name,
      trailing: `${fmt(item.remain)} / ${fmt(item.total)}`,
      icon: 'coin',
    })),
  }
}

export function stripData(snapshot, locale) {
  const w = words(locale)
  if (!snapshot.credential) return { text: `WorkBuddy: ${w.notLoggedIn}`, icon: 'coin' }
  if (!snapshot.credits) return { text: `WorkBuddy: ${w.loggedIn}`, icon: 'coin' }
  return { text: `WorkBuddy ${fmt(snapshot.credits.remain)}`, icon: 'coin' }
}

export function toolCard(build, maxBytes = 8 * 1024) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}

export function loginCard(value, locale) {
  const w = words(locale)
  return {
    type: 'stack',
    title: `WorkBuddy ${w.login}`,
    children: [
      { type: 'callout', text: w.hint, tone: 'info' },
      { type: 'keyValue', items: [
        [w.status, value.credential ? w.loggedIn : w.pending],
        ['URL', value.authUrl || '—'],
      ] },
    ],
  }
}

export function creditsCard(value, locale) {
  const w = words(locale)
  return {
    type: 'stack',
    title: `WorkBuddy ${w.remain}`,
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: w.remain, value: fmt(value.remain), tone: 'good' },
          { type: 'metric', label: w.total, value: fmt(value.total) },
        ],
      },
      { type: 'keyValue', items: [[w.account, value.account || '—']] },
      { type: 'list', items: (value.packages || []).map((item) => ({
        title: item.name,
        trailing: `${fmt(item.remain)} / ${fmt(item.total)}`,
        icon: 'coin',
      })) },
    ],
  }
}

export function chatCard(value, locale) {
  const w = words(locale)
  const answer = String(value.answer || '')
  const clipped = answer.length > 1800 ? `${answer.slice(0, 1800)}…` : answer
  return {
    type: 'stack',
    title: `WorkBuddy · ${value.model || 'model'}`,
    children: [
      { type: 'keyValue', items: [[w.model, value.model || '—'], [w.credit, fmt(value.credit)]] },
      { type: 'text', text: clipped || '—' },
    ],
  }
}

export function modelsCard(value, locale) {
  const w = words(locale)
  return {
    type: 'stack',
    title: 'WorkBuddy Models',
    children: [
      { type: 'text', text: `${value.models.length} models`, tone: 'muted' },
      { type: 'list', items: value.models.slice(0, 24).map((m) => ({ title: m.name, subtitle: m.id, icon: 'robot' })) },
      { type: 'text', text: w.toolHint, tone: 'muted' },
    ],
  }
}
