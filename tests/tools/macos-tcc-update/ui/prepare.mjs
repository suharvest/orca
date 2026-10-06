import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const beforeRef = process.env.ORCA_TCC_UI_BEFORE_REF
const output = path.join(root, beforeRef ? 'notes/tcc-repro/ui-before' : 'notes/tcc-repro/ui')
mkdirSync(output, { recursive: true })
await buildMain({
  entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
  outfile: path.join(output, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron']
})
await buildRenderer({
  configFile: false,
  root: import.meta.dirname,
  base: './',
  logLevel: 'silent',
  plugins: [
    ...(beforeRef
      ? [
          {
            name: 'permissions-before-proof',
            enforce: 'pre',
            load(id) {
              if (
                id ===
                path.join(root, 'src/renderer/src/components/settings/DeveloperPermissionsPane.tsx')
              ) {
                return execFileSync(
                  'git',
                  [
                    'show',
                    `${beforeRef}:src/renderer/src/components/settings/DeveloperPermissionsPane.tsx`
                  ],
                  { cwd: root, encoding: 'utf8' }
                )
              }
            }
          }
        ]
      : []),
    tailwindcss()
  ],
  resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
  build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
})
console.log(output)
