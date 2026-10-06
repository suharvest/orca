const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')

const runtime = process.argv[2]
const helper = path.resolve(
  path.dirname(process.execPath),
  '..',
  'Frameworks',
  'Orca Helper.app',
  'Contents',
  'MacOS',
  'Orca Helper'
)
const child = fork(path.join(__dirname, 'daemon.cjs'), [runtime], {
  execPath: helper,
  cwd: runtime,
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_BACKGROUND_LAUNCH: '1' }
})
child.once('message', (ready) => {
  fs.writeFileSync(path.join(runtime, 'ready.json'), JSON.stringify(ready))
  child.disconnect()
  child.unref()
  process.exit(0)
})
child.once('error', (error) => {
  fs.writeFileSync(path.join(runtime, 'error.json'), JSON.stringify({ code: error.code }))
  process.exit(1)
})
