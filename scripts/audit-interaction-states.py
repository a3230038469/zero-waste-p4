#!/usr/bin/env python3
"""
交互态审计工具 —— 扫描前端源码，找出「看起来能点、但没配齐悬停/焦点/按下」的元素。

用法（在仓库根目录）：

    python scripts/audit-interaction-states.py
    python scripts/audit-interaction-states.py frontend/src --json audit.json

退出码：0 = 全部配齐；1 = 有要补的（可直接接进 CI）。

判定口径（三条线取并集，所以报「缺」= 连兜底也罩不住，值得立刻动手）：
  1. 同文件内有无同名 `:hover` / `:focus*` / `:active` 规则
  2. 该 class 挂在原生可聚焦标签（button / a / input …）上时，算全站兜底生效
  3. global.css 里的 `:where(...):focus-visible` / `:active` 兜底必须真实存在

注意：CSS 注释会被并入选择器（因为注释在 `{` 之前的 buffer 里），
      所以比较前统一 strip 掉 `/* ... */`。
"""
import json
import os
import re
import sys
import glob


def strip_comment(sel: str) -> str:
    """去掉选择器里的 CSS 注释，并压平空白。"""
    sel = re.sub(r'/\*.*?\*/', ' ', sel, flags=re.S)
    return re.sub(r'\s+', ' ', sel).strip()


def parse(css: str):
    """括号栈式 CSS 解析：正确处理 @media / @keyframes 嵌套。"""
    rules = []
    buf = ''
    i = 0
    while i < len(css):
        c = css[i]
        if c == '{':
            j = i + 1
            d = 1
            while j < len(css) and d > 0:
                if css[j] == '{':
                    d += 1
                elif css[j] == '}':
                    d -= 1
                j += 1
            body = css[i + 1:j - 1]
            sel = strip_comment(buf)
            if sel.startswith('@'):
                rules += parse(body)          # @media / @supports 递归展平
            elif sel:
                rules.append((sel, body))
            buf = ''
            i = j
        else:
            buf += c
            i += 1
    return rules


def collect(root: str):
    files = sorted(
        glob.glob(os.path.join(root, '**', '*.vue'), recursive=True)
        + glob.glob(os.path.join(root, '**', '*.css'), recursive=True)
    )
    per = {}
    for f in files:
        rel = os.path.relpath(f, root)
        text = open(f, encoding='utf-8').read()
        if f.endswith('.vue'):
            m = re.search(r'<style[^>]*>(.*?)</style>', text, re.S)
            if not m:
                continue
            text = m.group(1)
        per[rel] = parse(text)
    return per


def split_selectors(sel: str):
    """按顶层逗号拆分选择器（括号/引号内的逗号不算）。

    不拆的话 `.a:hover .b, .b:focus-visible` 会被当成一个整体，
    导致 `.b` 的焦点态被误判为「缺失」。
    """
    out, buf, d = [], '', 0
    for ch in sel:
        if ch == '(':
            d += 1
        elif ch == ')':
            d -= 1
        if ch == ',' and d == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


NATIVE_FOCUSABLE = {'a', 'button', 'input', 'select', 'textarea', 'label', 'summary'}


def build_tag_index(root: str):
    """全局索引：class -> 它挂过的标签集合。

    公共类（如 global.css 里的 .zw-error__retry）定义在 CSS 文件中，
    单看该文件找不到标签，必须回到所有 .vue 模板里查它被用在哪。
    """
    idx = {}
    for f in glob.glob(os.path.join(root, '**', '*.vue'), recursive=True):
        try:
            tmpl = open(f, encoding='utf-8').read().split('<style')[0]
        except OSError:
            continue
        for m in re.finditer(r'<([a-zA-Z][\w-]*)\b[^>]*?class="([^"]*)"[^>]*>', tmpl, re.S):
            for cls in m.group(2).split():
                idx.setdefault(cls, set()).add(m.group(1))
    return {k: sorted(v) for k, v in idx.items()}


def global_fallback(per):
    """检测全站兜底：:where(...) 形式的 focus-visible / active。"""
    txt = '\n'.join(s for rs in per.values() for s, _ in rs)
    return {
        'focus': bool(re.search(r':where\([^)]*\)[^{]*:focus-visible', txt)),
        'active': bool(re.search(r':where\([^)]*\)[^{]*:active', txt)),
    }


def audit(per, root='.'):
    g = global_fallback(per)
    tidx = build_tag_index(root)
    rows = []
    for f, rs in per.items():
        # 一条规则可能含多个选择器，全部拆开参与匹配判断
        sels = [x for s, _ in rs for x in split_selectors(s)]
        for sel, body in rs:
            if not re.search(r'cursor:\s*pointer', body):
                continue
            base = sel.split(',')[0].strip()
            hover = any(s.startswith(base + ':hover') for s in sels)
            focus = any(s.startswith(base) and ':focus' in s for s in sels)
            active = any(s.startswith(base + ':active') for s in sels)

            tags = tidx.get(base.lstrip('.'), [])
            native = any(t in NATIVE_FOCUSABLE for t in tags)
            # 全站兜底只对原生可聚焦标签生效
            focus_eff = focus or (native and g['focus'])
            active_eff = active or (native and g['active'])

            if not hover:
                verdict = '缺 hover（要补）'
            elif not focus_eff or not active_eff:
                verdict = '缺焦点/按下（要补）'
            else:
                verdict = 'OK' + ('（按下靠全站兜底）' if active and not active else '（靠全站兜底）')

            rows.append({
                'file': f, 'selector': base, 'tags': tags,
                'hover': hover, 'focus': focus, 'active': active,
                'focus_eff': focus_eff, 'active_eff': active_eff,
                'verdict': verdict,
                'ok': hover and focus_eff and active_eff,
            })
    return rows


def main():
    # 默认扫前端源码；仓库根目录直接跑即可
    root = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.path.join('frontend', 'src')
    out = None
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]

    per = collect(root)
    rows = audit(per, root)
    bad = [r for r in rows if not r['ok']]
    g = global_fallback(per)

    print(f"\n===== 交互态审计：{root} =====")
    print(f"全站兜底：焦点环 {'有' if g['focus'] else '无'} / 按下态 {'有' if g['active'] else '无'}")
    print(f"可点元素(cursor:pointer) 共 {len(rows)} 处，真正要补的 {len(bad)} 处\n")
    print(f"{'文件':<30}{'选择器':<22}{'标签':<9}{'hover':>6}{'focus':>6}{'active':>7}  结论")
    print('-' * 108)
    for r in rows:
        print("{:<30}{:<22}{:<9}{:>6}{:>6}{:>7}  {}".format(
            r['file'][-28:], r['selector'][:20], ','.join(r['tags'])[:8],
            'y' if r['hover'] else '-',
            'y' if r['focus_eff'] else '-',
            'y' if r['active_eff'] else '-',
            r['verdict']))
    if bad:
        print("\n需要动手的：")
        for r in bad:
            print(f"  - {r['file']}  {r['selector']}  -> {r['verdict']}")

    if out:
        json.dump({'root': root, 'rows': rows, 'bad': bad},
                  open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f"\n明细已写入 {out}")

    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
