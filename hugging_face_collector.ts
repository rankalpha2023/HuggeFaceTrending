import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

type Sort = "trending" | "likes" | "downloads";

interface SlimModel {
  author: string;
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag: string;
  lastModified: string;
  numParameters: number | null;
  repoType: string;
}

interface RawModel {
  author?: string;
  id?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  lastModified?: string;
  numParameters?: number | null;
  repoType?: string;
  [key: string]: unknown;
}

interface RawResponse {
  models: RawModel[];
  numItemsPerPage: number;
  numTotalItems: number;
  pageIndex: number;
}

interface CategoryResult {
  category: string;
  sort: Sort;
  totalItems: number;
  fetchedItems: number;
  models: SlimModel[];
  fetchedAt: string;
}

const PIPELINE_TAGS = [
  "any-to-any",
  "audio-classification",
  "audio-text-to-text",
  "audio-to-audio",
  "automatic-speech-recognition",
  "depth-estimation",
  "feature-extraction",
  "fill-mask",
  "image-classification",
  "image-feature-extraction",
  "image-segmentation",
  "image-text-to-text",
  "image-to-3d",
  "image-to-text",
  "image-to-video",
  "keypoint-detection",
  "mask-generation",
  "object-detection",
  "question-answering",
  "robotics",
  "sentence-similarity",
  "summarization",
  "table-question-answering",
  "text-classification",
  "text-generation",
  "text-ranking",
  "text-to-audio",
  "text-to-image",
  "text-to-speech",
  "time-series-forecasting",
  "token-classification",
  "translation",
  "video-classification",
  "voice-activity-detection",
  "zero-shot-classification",
  "zero-shot-image-classification",
  "zero-shot-object-detection",
];

const SORTS: Sort[] = ["trending", "likes", "downloads"];
const MAX_PAGES = 5;
const REQUEST_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 60000;

const HF_BASE = process.env.HF_BASE || "https://huggingface.co";
const OUTPUT_DIR = process.env.OUTPUT_DIR || join(process.cwd(), "hugging_face");

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9\-_]/g, "_");
}

function slimModel(raw: RawModel): SlimModel {
  return {
    author: raw.author ?? "",
    id: raw.id ?? "",
    downloads: raw.downloads ?? 0,
    likes: raw.likes ?? 0,
    pipeline_tag: raw.pipeline_tag ?? "",
    lastModified: raw.lastModified ?? "",
    numParameters: raw.numParameters ?? null,
    repoType: raw.repoType ?? "model",
  };
}

async function fetchModels(
  pipelineTag: string | null,
  sort: Sort,
  page: number
): Promise<RawResponse> {
  const params = new URLSearchParams();
  if (pipelineTag) params.set("pipeline_tag", pipelineTag);
  params.set("sort", sort);
  params.set("withCount", "true");
  if (page > 0) params.set("p", String(page));

  const url = `${HF_BASE}/models-json?${params.toString()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return (await r.json()) as RawResponse;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCategory(
  category: string,
  pipelineTag: string | null,
  sort: Sort,
  maxPages: number
): Promise<CategoryResult> {
  const all: SlimModel[] = [];
  let total = 0;

  for (let page = 0; page < maxPages; page++) {
    try {
      console.log(`  ${category}/${sort} p${page}...`);
      const data = await fetchModels(pipelineTag, sort, page);
      total = data.numTotalItems;
      if (!data.models?.length) break;
      const slimmed = data.models.map(slimModel);
      all.push(...slimmed);
      console.log(`  +${data.models.length} (${all.length}/${total})`);
      if (all.length >= total) break;
      await sleep(REQUEST_DELAY_MS);
    } catch (e: any) {
      console.error(`  Err p${page}: ${e.message}`);
      break;
    }
  }

  const seen = new Set<string>();
  const unique = all.filter((m) => {
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  return {
    category,
    sort,
    totalItems: total,
    fetchedItems: unique.length,
    models: unique,
    fetchedAt: new Date().toISOString(),
  };
}

function save(
  baseDir: string,
  category: string,
  sort: Sort,
  result: CategoryResult
) {
  const dir = join(baseDir, sanitize(category), getToday());
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${sort}.json`);
  writeFileSync(fp, JSON.stringify(result, null, 2), "utf-8");
  console.log(`  -> ${fp} (${result.fetchedItems} models)`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let tagsOnly: string[] | null = null;
  let sortsOnly: Sort[] | null = null;
  let maxPages = MAX_PAGES;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tags" && args[i + 1]) {
      tagsOnly = args[i + 1].split(",");
      i++;
    } else if (args[i] === "--sorts" && args[i + 1]) {
      sortsOnly = args[i + 1].split(",") as Sort[];
      i++;
    } else if (args[i] === "--pages" && args[i + 1]) {
      maxPages = parseInt(args[i + 1], 10) || MAX_PAGES;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Hugging Face Trend Collector

Usage: bun run hugging_face_collector.ts [options]

Options:
  --tags <tag1,tag2,...>   Only fetch specific pipeline tags (default: all)
  --sorts <s1,s2,...>      Only fetch specific sorts (default: trending,likes,downloads)
  --pages <n>              Max pages per category (default: 5, each page=30 models)

Environment Variables:
  HF_BASE     Base URL for Hugging Face (default: https://huggingface.co)
              Use https://hf-mirror.com for China mirror
  OUTPUT_DIR  Output directory (default: ./hugging_face)

Examples:
  bun run hugging_face_collector.ts
  HF_BASE=https://hf-mirror.com bun run hugging_face_collector.ts
  bun run hugging_face_collector.ts --tags text-generation,image-to-image
  bun run hugging_face_collector.ts --sorts trending,downloads --pages 3
`);
      process.exit(0);
    }
  }

  return {
    tags: tagsOnly ?? PIPELINE_TAGS,
    sorts: sortsOnly ?? SORTS,
    maxPages,
  };
}

async function main() {
  const { tags, sorts, maxPages } = parseArgs();
  const baseDir = resolve(OUTPUT_DIR);
  mkdirSync(baseDir, { recursive: true });

  console.log("=== Hugging Face Trend Collector ===");
  console.log(`HF_BASE:     ${HF_BASE}`);
  console.log(`Output:      ${baseDir}`);
  console.log(`Date:        ${getToday()}`);
  console.log(`Tags:        ${tags.length}`);
  console.log(`Sorts:       ${sorts.join(", ")}`);
  console.log(`Max pages:   ${maxPages} (up to ${maxPages * 30} models per category/sort)`);
  console.log("");

  console.log("--- Overall models ---");
  for (const sort of sorts) {
    console.log(`\n[models/${sort}]`);
    const r = await fetchCategory("models", null, sort, maxPages);
    save(baseDir, "models", sort, r);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log("\n--- Per pipeline tag ---");
  for (const tag of tags) {
    for (const sort of sorts) {
      console.log(`\n[${tag}/${sort}]`);
      const r = await fetchCategory(tag, tag, sort, maxPages);
      save(baseDir, tag, sort, r);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log("\n=== Done! ===");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
