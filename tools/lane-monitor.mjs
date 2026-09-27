// Persistent fleet-lane monitor without child processes (the bash loop died twice with exit 255).
// Refreshes the mode:"monitor" lock atomically every 10 s and prints one line per unseen inbox message.
// usage: node lane-monitor.mjs <fleet home> <lane>
import fs from 'node:fs'
import path from 'node:path'

const [home, lane] = process.argv.slice(2)
const inbox = path.join(home, lane, 'inbox')
const lock = path.join(home, lane, '.listening')
// Monitor expiry on Windows orphans this process (parent chain survives), so the newest instance owns the lane:
// an older one exits as soon as it sees another pid in the owner file.
const owner = path.join(home, lane, '.monitor-owner')
fs.writeFileSync(owner, String(process.pid))
const seen = new Set()
let failing = false

function tick() {
  try { if (fs.readFileSync(owner, 'utf8') !== String(process.pid)) process.exit(0) } catch { /* owner file briefly missing */ }
  try {
    const tmp = `${lock}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), mode: 'monitor' }))
    fs.renameSync(tmp, lock)
    const files = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).sort() : []
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      let id = file.replace(/\.json$/, '')
      let subject = '(unreadable)'
      try {
        const msg = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'))
        id = msg.id ?? id
        subject = msg.subject ?? subject
      } catch { /* partially written; the id still surfaces */ }
      console.log(`FLEET WAKE (${lane}): ${subject} (id=${id})`)
    }
    failing = false
  } catch (e) {
    if (!failing) console.log(`MONITOR ERROR (${lane}): ${e.message}`)
    failing = true
  }
}

const stop = () => { try { fs.unlinkSync(lock) } catch { /* already gone */ } process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
tick()
setInterval(tick, 10000)
