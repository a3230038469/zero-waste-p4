<template>
  <el-result icon="warning" title="页面不存在" sub-title="请检查网址是否正确">
    <template #extra>
      <RouterLink to="/"><el-button type="primary">回到首页</el-button></RouterLink>
    </template>
  </el-result>
</template>
