<script setup lang="ts">
/**
 * 书架页 —— 负责人：丁梓柔（B05）
 *
 *  1. 顶部类型标签：全部/政策法规/案例工具/研究报告/标准规范
 *  2. 筛选区：机构、年份、主题多选下拉，选项带计数（如 垃圾分类(120)）
 *  3. 搜索框，回车触发
 *  4. 资料卡片：标题/机构/年份/类型/标签，点击进详情 /doc/:id
 *  5. 零结果：显示「没有匹配的资料」+【试试问 AI】
 *  6. 分页：每页 20 条，底部
 *  7. 加载中显示骨架屏
 *
 * 数据走 src/api/docs.ts（当前假数据，结构对齐 GET /api/docs、/api/docs/facets）。
 * 首页搜索跳转 /shelf?q=xxx 时自动带入关键词。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getFacets, type DocListQuery } from '../api/docs'
import type { DocListResponse, FacetsResponse } from '../api/types'

const PAGE_SIZE = 20
const TYPE_TABS = ['全部', '政策法规', '案例工具', '研究报告', '标准规范']

const router = useRouter()
const route = useRoute()

const activeType = ref('全部')
const selectedOrgs = ref<string[]>([])
const selectedYears = ref<string[]>([])
const selectedTags = ref<string[]>([])
const keyword = ref('')
const page = ref(1)
const loading = ref(false)
const list = ref<DocListResponse | null>(null)
const facets = ref<FacetsResponse>({ types: [], orgs: [], years: [], tags: [] })

const items = computed(() => list.value?.items ?? [])
const total = computed(() => list.value?.total ?? 0)

function buildQuery(): DocListQuery {
  return {
    type: activeType.value === '全部' ? undefined : activeType.value,
    orgs: selectedOrgs.value,
    years: selectedYears.value,
    tags: selectedTags.value,
    q: keyword.value.trim() || undefined,
    page: page.value,
    pageSize: PAGE_SIZE
  }
}

async function fetchList(): Promise<void> {
  loading.value = true
  try {
    list.value = await getDocs(buildQuery())
  } finally {
    loading.value = false
  }
}

async function fetchFacets(): Promise<void> {
  facets.value = await getFacets(buildQuery())
}

/** 筛选条件变化：回到第 1 页，列表与筛选项计数一起刷新 */
function onFilterChange(): void {
  page.value = 1
  void fetchList()
  void fetchFacets()
}

function onPageChange(p: number): void {
  page.value = p
  void fetchList()
}

function goDetail(id: string): void {
  router.push(`/doc/${id}`)
}

/** 零结果时引导去首页问 AI（首页有问答入口，B07 负责） */
function goAskAi(): void {
  router.push('/')
}

onMounted(() => {
  const q = route.query.q
  if (typeof q === 'string' && q) {
    keyword.value = q
  }
  onFilterChange()
})

// 已在书架页时，首页再次搜索会带新的 ?q= 过来
watch(
  () => route.query.q,
  (q) => {
    keyword.value = typeof q === 'string' ? q : ''
    onFilterChange()
  }
)
</script>

<template>
  <section class="shelf">
    <h2>资料书架</h2>

    <!-- 1. 类型标签切换 -->
    <el-tabs v-model="activeType" class="type-tabs" @tab-change="onFilterChange">
      <el-tab-pane v-for="t in TYPE_TABS" :key="t" :label="t" :name="t" />
    </el-tabs>

    <!-- 2. 筛选区 + 3. 搜索框 -->
    <div class="toolbar">
      <el-select
        v-model="selectedOrgs"
        multiple
        collapse-tags
        clearable
        placeholder="机构"
        class="filter-select"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.orgs" :key="f.value" :label="`${f.value}(${f.count})`" :value="f.value" />
      </el-select>
      <el-select
        v-model="selectedYears"
        multiple
        collapse-tags
        clearable
        placeholder="年份"
        class="filter-select filter-year"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.years" :key="f.value" :label="`${f.value}(${f.count})`" :value="f.value" />
      </el-select>
      <el-select
        v-model="selectedTags"
        multiple
        collapse-tags
        clearable
        placeholder="主题"
        class="filter-select"
        @change="onFilterChange"
      >
        <el-option v-for="f in facets.tags" :key="f.value" :label="`${f.value}(${f.count})`" :value="f.value" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="搜索资料名称、机构……"
        clearable
        class="search-input"
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />
    </div>

    <!-- 7. 骨架屏 -->
    <div v-if="loading" class="cards">
      <div v-for="n in 8" :key="n" class="doc-card">
        <el-skeleton :rows="2" animated />
      </div>
    </div>

    <template v-else-if="items.length > 0">
      <!-- 4. 资料卡片列表 -->
      <div class="cards">
        <article v-for="doc in items" :key="doc.id" class="doc-card" @click="goDetail(doc.id)">
          <h3 class="doc-title">{{ doc.title }}</h3>
          <p class="doc-meta">
            <span>{{ doc.org }}</span>
            <span>{{ doc.year }}</span>
            <el-tag size="small" effect="plain">{{ doc.type }}</el-tag>
          </p>
          <p class="doc-tags">
            <el-tag v-for="t in doc.tags" :key="t" size="small" type="success" effect="light">{{ t }}</el-tag>
          </p>
        </article>
      </div>

      <!-- 6. 分页 -->
      <div class="pager">
        <el-pagination
          background
          layout="total, prev, pager, next"
          :total="total"
          :page-size="PAGE_SIZE"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </template>

    <!-- 5. 零结果 -->
    <el-empty v-else description="没有匹配的资料">
      <el-button type="primary" @click="goAskAi">试试问 AI</el-button>
    </el-empty>
  </section>
</template>

<style scoped>
.shelf h2 {
  margin: 8px 0 4px;
  color: var(--zw-green);
}
.type-tabs {
  margin-bottom: 4px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}
.filter-select {
  width: 220px;
}
.filter-year {
  width: 160px;
}
.search-input {
  width: 260px;
  margin-left: auto;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.doc-card {
  background: #fff;
  border: 1px solid #e3ece3;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition:
    box-shadow 0.2s,
    transform 0.2s;
}
.doc-card:hover {
  box-shadow: 0 4px 16px rgba(46, 125, 50, 0.15);
  transform: translateY(-2px);
}
.doc-title {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 1.5;
  color: var(--zw-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.doc-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0 0 10px;
  font-size: 13px;
  color: #6b7a6b;
}
.doc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
}
.pager {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}

/* 手机窄屏：筛选区整体换行、搜索框占满一行 */
@media (max-width: 480px) {
  .filter-select,
  .filter-year,
  .search-input {
    width: 100%;
    margin-left: 0;
  }
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>
