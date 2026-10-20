// 一次性排查脚本：从 --dump-dom 的 HTML 里摘出筛选区，看 v-show 的真实结果
// 用法：node .agent/audit/tools/peek-toolbar.mjs <dom.html>
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')

function slice(label, needle, before = 200, after = 1500) {
  const i = html.indexOf(needle)
  console.log(`\n===== ${label} ===== (index ${i})`)
  if (i < 0) {
    console.log('!! 没找到')
    return
  }
  console.log(html.slice(i - before, i + after).replace(/></g, '>\n<'))
}

slice('筛选区', 'class="toolbar"', 120, 2600)
slice('更多筛选面板', 'toolbar--more', 120, 900)
