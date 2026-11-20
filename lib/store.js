// Local state for dsh-go-workbuddy-connect.
// All files live under $DSH_HOME (the phone engine's DSH home, usually
// /root/.dsh). Tokens are credentials: write with 0600 and never log them.

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEVICE_ID_NAMESPACE = 'dsh-go-workbuddy-connect/device/v1'

/** DSH home in the phone engine; fall back to ~/.dsh for local development. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  return configured && configured.trim() !== '' ? configured.trim() : path.join(os.homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'workbuddy-go-connect')
}

const paths = {
  credential: () => path.join(stateDir(), 'credential.json'),
  pending: () => path.join(stateDir(), 'pending-login.json'),
  salt: () => path.join(stateDir(), 'device-salt'),
  models: () => path.join(stateDir(), 'models.json'),
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.chmod(file, 0o600)
  } catch {
    // Some phone filesystems ignore chmod; the file still stays inside DSH_HOME.
  }
}

async function remove(file) {
  try {
    await fs.unlink(file)
  } catch {
    // Already absent.
  }
}

export async function readCredential() {
  const value = await readJson(paths.credential(), null)
  if (!value || typeof value.accessToken !== 'string' || value.accessToken === '') return null
  return value
}

export async function saveCredential(credential) {
  await writeJson(paths.credential(), credential)
}

export async function clearCredential() {
  await remove(paths.credential())
}

export async function readPendingLogin() {
  const value = await readJson(paths.pending(), null)
  if (!value || typeof value.state !== 'string' || value.state === '') return null
  return value
}

export async function savePendingLogin(pending) {
  await writeJson(paths.pending(), pending)
}

export async function clearPendingLogin() {
  await remove(paths.pending())
}

export async function readModels() {
  const value = await readJson(paths.models(), null)
  if (!value || !Array.isArray(value.models)) return null
  return value.models
}

export async function saveModels(models) {
  await writeJson(paths.models(), { models, savedAt: Date.now() })
}

/**
 * A stable, per-install random salt. Never invent a temporary one: that would
 * make every engine restart look like a different device.
 */
export async function deviceSalt() {
  try {
    const text = (await fs.readFile(paths.salt(), 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(text)) return text
  } catch {
    // No salt yet.
  }
  const fresh = randomBytes(32).toString('hex')
  await fs.mkdir(stateDir(), { recursive: true })
  await fs.writeFile(paths.salt(), fresh, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.chmod(paths.salt(), 0o600)
  } catch {
    // Ignore unsupported chmod.
  }
  return fresh
}

/** Account-scoped virtual device id, matching the reference plugin's shape. */
export async function deviceHeaders(credential) {
  if (!credential || typeof credential.uid !== 'string' || credential.uid === '') return {}
  const salt = await deviceSalt()
  const derive = (purpose) => createHash('sha256')
    .update(`${DEVICE_ID_NAMESPACE}\0${salt}\0${purpose}\0${credential.uid}`, 'utf8')
    .digest('hex')
    .slice(0, 36)
  return {
    'X-Machine-ID': derive('machine'),
    'X-Session-ID': derive('session'),
  }
}
