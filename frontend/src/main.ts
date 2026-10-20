import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// 设计令牌补充层（字号/间距/动效/状态色变量）。放最前：只定义变量，供后续样式引用。
import './styles/tokens.css'
// 全站设计令牌与公共样式。必须放在 element-plus 之后：里面覆盖了它的主色变量。
import './styles/global.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(ElementPlus)
app.use(router)
app.mount('#app')
