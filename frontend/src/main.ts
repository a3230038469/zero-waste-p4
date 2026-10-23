import { createApp } from 'vue'
import ElementPlus from 'element-plus'
// T3 · 公-5（2026-10-21）：Element Plus 默认英文（分页器底部那行 "Total 20"）。
// 注册官方中文语言包，全站组件（分页、日期选择、空状态…）一起变中文。
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// 全站设计令牌与公共样式。必须放在 element-plus 之后：里面覆盖了它的主色变量。
import './styles/global.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')
