const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const runtime = process.argv[2]
const probeScript = `const fs=require('node:fs');const path=require('node:path');const os=require('node:os');let code='ok';try{const fd=fs.openSync(path.join(os.homedir(),'Library','Application Support','com.apple.TCC','TCC.db'),'r');try{fs.readSync(fd,Buffer.alloc(1),0,1,0)}finally{fs.closeSync(fd)}}catch(e){code=e.code||'unknown'}process.stdout.write(JSON.stringify({code}))`

const server = net.createServer((socket) => {
  socket.once('data', (data) => {
    const request = JSON.parse(data)
    if (request.type === 'exit') {
      socket.end('{}\n')
      server.close(() => process.exit(0))
      return
    }
    const native = request.type === 'native'
    const child = spawnSync(
      native ? '/usr/bin/head' : process.execPath,
      native
        ? [
            '-c',
            '1',
            path.join(
              require('node:os').homedir(),
              'Library',
              'Application Support',
              'com.apple.TCC',
              'TCC.db'
            )
          ]
        : ['-e', probeScript],
      {
        cwd: runtime,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_BACKGROUND_LAUNCH: '1' }
      }
    )
    const code = child.error
      ? child.error.code
      : native
        ? child.status === 0
          ? 'ok'
          : /Operation not permitted|Permission denied/.test(child.stderr)
            ? 'EPERM'
            : 'unknown'
        : child.status === 0
          ? JSON.parse(child.stdout).code
          : 'unknown'
    socket.end(`${JSON.stringify({ pid: process.pid, code })}\n`)
  })
})

server.listen(path.join(runtime, 'daemon.sock'), () => {
  const ready = { pid: process.pid, executable: process.execPath }
  if (process.send) {
    process.send(ready)
  } else {
    fs.writeFileSync(path.join(runtime, 'ready.json'), JSON.stringify(ready))
  }
})
