# -*- coding: utf-8 -*-
"""
Vue/SCSS 样式层规格度量器。

用途：对两个仓库的 frontend 做同一套指标采集，产出可比对的数字（不做主观评价）。

用法（仓库根目录，三个参数都可省）：
    python scripts/analyze-style-coverage.py
    python scripts/analyze-style-coverage.py before frontend/src stat-before.json

想看出改造成效，就改造前后各跑一次，把两份 JSON 放一起对比。
"""
import os
import re
import sys
import json

PATTERNS = {
    'hover': r':hover\b',
    'focus_any': r':focus\b|:focus-visible\b|:focus-within\b',
    'active': r':active\b',
    'disabled': r':disabled\b|\.is-disabled\b|\[disabled\]',
    'transition': r'\btransition\b',
    'media_query': r'@media\b',
    'reduced_motion': r'prefers-reduced-motion',
    'keyframes': r'@keyframes\b',
    'hard_font_size': r'font-size:\s*\d',
    'hard_color_hex': r'#[0-9a-fA-F]{3,8}\b',
    'hard_color_rgb': r'\brgba?\(',
    'var_zw': r'var\(--zw-',
    'var_el': r'var\(--el-',
    'skeleton': r'skeleton|Skeleton|骨架',
    'empty_state': r'empty|Empty|空态|暂无|没有找到|没有匹配',
    'error_state': r'error|Error|失败|错误|retry|重试',
    'loading_state': r'loading|Loading|加载中',
}

STYLE_RE = re.compile(r'<style[^>]*>(.*?)</style>', re.S)


def measure_file(path):
    src = open(path, encoding='utf-8', errors='ignore').read()
    if path.endswith('.css'):
        # 独立样式文件（如 global.css / tokens.css）本身就是 CSS，直接全文统计；
        # 但要剥掉 :root 里的变量「定义」区，否则会把令牌定义本身误算成覆盖率。
        blocks = STYLE_RE.findall(src)
        css = '\n'.join(blocks) if blocks else src
        scoped = False
    else:
        blocks = STYLE_RE.findall(src)
        css = '\n'.join(blocks)
        scoped = len(re.findall(r'<style[^>]*\bscoped\b', src)) > 0
    lines = len(css.splitlines())
    row = {'scoped': scoped, 'css_lines': lines}
    for k, p in PATTERNS.items():
        row[k] = len(re.findall(p, css))
    row['total_lines'] = len(src.splitlines())
    return row


def measure_dir(root, exclude_dirs=('node_modules', '.git')):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        for fn in filenames:
            if fn.endswith(('.vue', '.ts', '.css')):
                files.append(os.path.join(dirpath, fn))
    files.sort()
    out = {}
    for f in files:
        rel = os.path.relpath(f, root).replace('\\', '/')
        try:
            out[rel] = measure_file(f)
        except Exception:
            pass
    return out


def summarize(per_file):
    keys = list(PATTERNS.keys())
    agg = {k: 0 for k in keys}
    agg['files'] = 0
    agg['css_lines'] = 0
    agg['scoped_files'] = 0
    agg['total_lines'] = 0
    for _, r in per_file.items():
        agg['files'] += 1
        agg['css_lines'] += r['css_lines']
        agg['total_lines'] += r['total_lines']
        if r['scoped']:
            agg['scoped_files'] += 1
        for k in keys:
            agg[k] += r[k]
    return agg


def main():
    # 三个参数都可省：默认扫 frontend/src，输出 docs/shots/stat-<标签>.json
    label = sys.argv[1] if len(sys.argv) > 1 else 'snapshot'
    root = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.path.join('frontend', 'src')
    )
    out = (
        sys.argv[3]
        if len(sys.argv) > 3
        else os.path.join('docs', 'shots', f'stat-{label}.json')
    )
    per = measure_dir(root)
    agg = summarize(per)
    result = {'label': label, 'root': root, 'aggregate': agg, 'per_file': per}
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(result, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    a = agg
    print(f"\n===== {label} =====")
    print(f"文件数 {a['files']}  |  CSS 行数 {a['css_lines']}  |  scoped 文件 {a['scoped_files']}  |  源码总行 {a['total_lines']}")
    print(f"hover {a['hover']:>4}  focus {a['focus_any']:>4}  active {a['active']:>4}  disabled {a['disabled']:>4}  transition {a['transition']:>4}")
    print(f"@media {a['media_query']:>4}  reduced-motion {a['reduced_motion']:>4}  keyframes {a['keyframes']:>4}")
    print(f"硬编码 font-size {a['hard_font_size']:>4}  hex色 {a['hard_color_hex']:>4}  rgba {a['hard_color_rgb']:>4}")
    print(f"var(--zw-) {a['var_zw']:>4}  var(--el-) {a['var_el']:>4}")
    print(f"skeleton {a['skeleton']:>4}  empty {a['empty_state']:>4}  error {a['error_state']:>4}  loading {a['loading_state']:>4}")


if __name__ == '__main__':
    main()
