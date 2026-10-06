/**
 * WeKnora 引擎对接层 —— 负责人：韶茹
 *
 * 全组唯一跟引擎打交道的地方。封装好后，其他板块不用管细节。
 *
 * 要封装的接口（详见 docs/接口约定.md 第五节）：
 *   listFiles(kbId)                     取知识库文件列表
 *   hybridSearch(kbId, query)           混合检索
 *   getDoc(id)                          文档详情
 *   getPreview(id)                      预览内容
 *   getDownload(id)                     下载原件
 *   exchangeEmbedToken(channelId)       换取问答临时钥匙
 *
 * 认证：请求头 X-API-Key，地址读 .env 的 WEKNORA_BASE_URL
 * 要求：出错要给清晰错误信息，不能让它崩掉整个服务
 */
export {}
