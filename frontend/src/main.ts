import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// 全站设计令牌与公共样式。必须放在 element-plus 之后：里面覆盖了它的主色变量。
import './styles/global.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(ElementPlus)
app.use(router)
app.mount('#app')
