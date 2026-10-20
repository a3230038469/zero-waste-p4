/**
 * 管理员身份维护 CLI —— 2026-10-19 新增
 *
 * 用法（在 backend 目录）：
 *   npm run admin:role -- list                 看现在谁是管理员
 *   npm run admin:role -- grant 13800000000    按手机号授予管理员
 *   npm run admin:role -- grant 张三           按姓名授予（重名会拒绝，让你改用手机号）
 *   npm run admin:role -- revoke 13800000000   撤销管理员（回到普通用户）
 *
 * 为什么不做成网页按钮：授予管理员是「开权限」这种低频且高风险的动作，
 * 放在命令行里意味着只有能进这台机器的人才能做，而且每一次都有终端记录。
 * 管理台里因此**没有**「提升为管理员」的入口。
 *
 * 安全兜底：仓库里不存在任何默认管理员。谁都不是管理员时，管理台一律 403，
 * 不会因为「没人管」就放行。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type Action = 'list' | 'grant' | 'revoke'

async function findUser(needle: string) {
  const byPhone = await prisma.user.findUnique({ where: { phone: needle } })
  if (byPhone) return { user: byPhone, matchedBy: '手机号' as const }

  const byName = await prisma.user.findMany({ where: { name: needle } })
  if (byName.length === 1) return { user: byName[0], matchedBy: '姓名' as const }
  if (byName.length > 1) {
    console.log(`姓名「${needle}」匹配到 ${byName.length} 个用户，请改用手机号：`)
    for (const u of byName) console.log(`  ${u.phone}  ${u.name}  ${u.org}`)
    return null
  }
  return null
}

async function main(): Promise<void> {
  const action = (process.argv[2] ?? 'list') as Action
  const needle = (process.argv[3] ?? '').trim()

  if (!['list', 'grant', 'revoke'].includes(action)) {
    console.log('用法：npm run admin:role -- <list|grant|revoke> [手机号或姓名]')
    process.exitCode = 1
    return
  }

  if (action === 'list') {
    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { phone: true, name: true, org: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    })
    if (!admins.length) {
      console.log('当前没有管理员 —— 管理台一律 403。用 `npm run admin:role -- grant <手机号>` 指定一个。')
    } else {
      console.log(`当前管理员 ${admins.length} 位：`)
      for (const a of admins) console.log(`  ${a.phone}  ${a.name}  ${a.org}`)
    }
    return
  }

  if (!needle) {
    console.log('请给出手机号或姓名，例如：npm run admin:role -- grant 13800000000')
    process.exitCode = 1
    return
  }

  const found = await findUser(needle)
  if (!found) {
    console.log(`没找到用户「${needle}」—— 让对方先在本站注册，再执行这条命令。`)
    process.exitCode = 1
    return
  }

  const { user, matchedBy } = found
  const nextRole = action === 'grant' ? 'admin' : 'user'
  if (user.role === nextRole) {
    console.log(`${user.name}（${user.phone}）已经是「${nextRole}」，无需改动。`)
    return
  }

  // 撤销最后一个管理员会直接把管理台锁死（只能再回来跑命令），提醒一句但不阻止
  if (action === 'revoke') {
    const adminCount = await prisma.user.count({ where: { role: 'admin' } })
    if (adminCount <= 1) {
      console.log('⚠️ 这是最后一位管理员：撤销后管理台将没有人能进，只能再用本命令授予。')
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: nextRole } })
  console.log(`已把 ${user.name}（${user.phone}，按${matchedBy}匹配）设为「${nextRole}」。`)
  console.log(action === 'grant' ? '对方重新登录（或刷新页面）后即可进入 /admin。' : '对方立即失去管理台权限（角色每次请求都查库）。')
}

main()
  .catch((err) => {
    console.error('执行失败：', err)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
