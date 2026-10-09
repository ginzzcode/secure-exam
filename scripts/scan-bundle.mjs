// Build-time scan of the generated frontend bundle for privileged secrets.
//
// PURPOSE
// This guards the rule that the browser build contains only the Supabase URL
// and the publishable (anon) key. It fails the build when a service-role key or
// another recognized privileged secret appears in the output.
//
// WHAT IT DETECTS
//   1. JSON Web Tokens whose decoded payload carries a privileged role
//      (service_role, supabase_admin, supabase_auth_admin, supabase_storage_admin).
//      Anon and authenticated tokens are allowed.
//   2. Supabase secret API keys, which use the `sb_secret_` prefix.
//   3. PEM-encoded private keys (RSA, EC, PKCS8, OPENSSH).
//   4. Any `VITE_` variable name containing SERVICE, SECRET, or PRIVATE, because
//      Vite inlines every `VITE_` variable into the bundle.
//   5. Literal service-key variable names (for example SUPABASE_SERVICE_ROLE_KEY),
//      which must never appear in frontend output at all.
//
// LIMITATIONS
// This is a best-effort string and token scan, not a proof of safety. It cannot
// detect obfuscated, split, encoded, or dynamically constructed secrets, secrets
// fetched at runtime, or secret formats it does not know. A passing scan does not
// mean the bundle is secret-free; it means none of the recognized patterns were
// found. Pair it with review and least privilege.
//
// USAGE
//   node scripts/scan-bundle.mjs [output-dir]   (default: dist)
// Exits 0 when clean, 1 when a finding exists or the output is missing.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const outputDir = process.argv[2] ?? 'dist'

const PRIVILEGED_ROLES = new Set([
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
])

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.css', '.html', '.json', '.map', '.txt', '.svg',
])

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g
const SECRET_KEY_PATTERN = /sb_secret_[A-Za-z0-9_-]{8,}/g
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g
const VITE_PRIVILEGED_NAME_PATTERN = /\bVITE_[A-Z0-9_]*(?:SERVICE|SECRET|PRIVATE)[A-Z0-9_]*/g
const LITERAL_SERVICE_NAME_PATTERN = /\b(?:SUPABASE_)?SERVICE_ROLE_KEY\b|\bSUPABASE_SERVICE_KEY\b/g

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.')
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(normalized, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function mask(value) {
  if (value.length <= 12) return '***'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function scanText(text) {
  const findings = []

  for (const match of text.matchAll(JWT_PATTERN)) {
    const payload = decodeJwtPayload(match[0])
    if (payload && PRIVILEGED_ROLES.has(payload.role)) {
      findings.push({
        rule: 'privileged-jwt-role',
        detail: `JWT with role "${payload.role}"`,
        sample: mask(match[0]),
      })
    }
  }

  for (const match of text.matchAll(SECRET_KEY_PATTERN)) {
    findings.push({
      rule: 'supabase-secret-key',
      detail: 'Supabase secret key (sb_secret_ prefix)',
      sample: mask(match[0]),
    })
  }

  for (const match of text.matchAll(PRIVATE_KEY_PATTERN)) {
    findings.push({
      rule: 'private-key',
      detail: match[0],
      sample: match[0],
    })
  }

  for (const match of text.matchAll(VITE_PRIVILEGED_NAME_PATTERN)) {
    findings.push({
      rule: 'privileged-vite-variable',
      detail: match[0],
      sample: match[0],
    })
  }

  for (const match of text.matchAll(LITERAL_SERVICE_NAME_PATTERN)) {
    findings.push({
      rule: 'service-key-name',
      detail: match[0],
      sample: match[0],
    })
  }

  return findings
}

async function main() {
  try {
    const info = await stat(outputDir)
    if (!info.isDirectory()) {
      throw new Error('not a directory')
    }
  } catch {
    console.error(`scan-bundle: output directory "${outputDir}" not found. Run "npm run build" first.`)
    process.exit(1)
  }

  const files = await collectFiles(outputDir)
  const findings = []
  let scanned = 0

  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'))
    if (!TEXT_EXTENSIONS.has(ext)) continue
    scanned += 1
    const text = await readFile(file, 'utf8')
    for (const finding of scanText(text)) {
      findings.push({ file: relative(process.cwd(), file), ...finding })
    }
  }

  if (findings.length > 0) {
    console.error(`scan-bundle: FAILED. ${findings.length} finding(s) in "${outputDir}":`)
    for (const finding of findings) {
      console.error(`  - [${finding.rule}] ${finding.file}: ${finding.detail} (${finding.sample})`)
    }
    console.error('Remove the privileged secret from the frontend build before shipping.')
    process.exit(1)
  }

  console.log(
    `scan-bundle: PASSED. Scanned ${scanned} text file(s) in "${outputDir}"; no recognized privileged secret patterns found.`,
  )
  console.log('Note: this is a best-effort scan and does not prove the bundle is free of every secret.')
}

main()
