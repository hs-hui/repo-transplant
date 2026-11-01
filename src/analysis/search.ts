import path from "node:path";
import { sanitizeDisplay } from "../util/text.js";
import { productionFanIn, type RepoGraph } from "./graph.js";

/** Common feature vocabulary, including Korean terms, expanded to the words code actually uses. */
const SYNONYMS: Record<string, string[]> = {
  로그인: ["login", "signin", "sign_in", "auth", "session"],
  회원가입: ["signup", "register", "registration", "sign_up"],
  인증: ["auth", "authentication", "verify", "token", "jwt", "session"],
  권한: ["permission", "role", "rbac", "authorize", "policy"],
  검색: ["search", "query", "filter", "find"],
  필터: ["filter", "facet"],
  정렬: ["sort", "order"],
  드래그: ["drag", "drop", "dnd", "sortable"],
  결제: ["payment", "checkout", "stripe", "billing", "subscription", "invoice"],
  구독: ["subscription", "billing", "plan"],
  장바구니: ["cart", "basket", "checkout"],
  알림: ["notification", "notify", "toast", "alert"],
  채팅: ["chat", "message", "conversation", "websocket"],
  댓글: ["comment", "reply", "thread"],
  파일업로드: ["upload", "file", "attachment", "storage"],
  업로드: ["upload", "file", "attachment", "storage"],
  이메일: ["email", "mail", "smtp"],
  다크모드: ["dark", "theme", "colorscheme"],
  테마: ["theme", "dark", "palette"],
  커맨드: ["command", "palette", "cmdk", "kbar"],
  팔레트: ["palette", "command"],
  단축키: ["shortcut", "hotkey", "keybinding", "keyboard"],
  모달: ["modal", "dialog", "popup"],
  페이지네이션: ["pagination", "paginate", "cursor"],
  무한스크롤: ["infinite", "scroll", "intersection", "cursor"],
  대시보드: ["dashboard", "analytics", "chart"],
  차트: ["chart", "graph", "plot"],
  프로필: ["profile", "account", "avatar"],
  설정: ["settings", "preferences", "config"],
  다국어: ["i18n", "locale", "translation", "intl"],
  캐시: ["cache", "redis", "memo"],
  큐: ["queue", "job", "worker"],
  스케줄: ["schedule", "cron", "job"],
  웹훅: ["webhook", "callback", "signature"],
  로그: ["log", "logger", "logging", "audit"],
  에디터: ["editor", "richtext", "markdown", "wysiwyg"],
  auth: ["authentication", "login", "session", "token", "oauth"],
  login: ["signin", "auth", "session"],
  signup: ["register", "registration"],
  payment: ["checkout", "billing", "stripe", "invoice"],
  dnd: ["drag", "drop", "sortable"],
  drag: ["dnd", "drop", "sortable", "draggable"],
  notification: ["notify", "toast", "alert"],
  upload: ["file", "attachment", "multipart", "storage"],
  search: ["query", "filter", "index", "autocomplete"],
  palette: ["command", "cmdk", "kbar"],
  webhook: ["callback", "signature", "event"],
  rate: ["limit", "throttle", "limiter"],
  limit: ["rate", "throttle"],
  cache: ["redis", "memoize", "ttl"],
  queue: ["job", "worker", "bull", "celery"],
};

const STOPWORDS = new Set(
  "the a an and or of to in on for with from by is are be this that it feature function add support 기능 추가 구현 만들어 해줘".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && token.length < 40);
}

export function expandQuery(query: string, extraTerms: string[] = []): { term: string; weight: number }[] {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    if (STOPWORDS.has(term)) return;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };
  for (const token of [...tokenize(query), ...extraTerms.flatMap(tokenize)]) {
    add(token, 1);
    for (const [key, synonyms] of Object.entries(SYNONYMS)) {
      if (token === key || (/[^\x00-\x7f]/.test(key) && token.includes(key))) {
        if (token !== key) add(key, 0.9);
        for (const synonym of synonyms) add(synonym, 0.6);
      }
    }
  }
  return [...weights].map(([term, weight]) => ({ term, weight }));
}

export interface SearchHit {
  path: string;
  score: number;
  file_class: string;
  matched_terms: string[];
  fan_in: number;
  highlights: { line: number; text: string }[];
}

export interface SearchCluster {
  directory: string;
  score: number;
  files: string[];
}

export interface SearchResult {
  terms: string[];
  hits: SearchHit[];
  clusters: SearchCluster[];
  suggested_seeds: string[];
  indexed_files: number;
}

/** Schema and migration files describe a feature but make poor starting points for tracing imports. */
const DATA_DEFINITION = /(\.(sql|prisma|graphql|gql|proto)$|(^|\/)migrations?\/)/;
const K1 = 1.4;
const B = 0.75;
const PATH_BOOST = 6;
const SYMBOL_BOOST = 3;
const SYMBOL_LINE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const|interface|type|def|func|fn|struct|enum|module|trait|impl|public|private)\b.*$/;

/** Ranks files with BM25, weighting path and declaration matches above body matches. */
export function searchFeature(
  graph: RepoGraph,
  query: string,
  options: { keywords?: string[]; limit?: number; includeTests?: boolean } = {},
): SearchResult {
  const terms = expandQuery(query, options.keywords);
  const termNames = terms.map((item) => item.term);
  const docs: { rel: string; length: number; tf: Map<string, number>; pathTerms: Set<string> }[] = [];
  const documentFrequency = new Map<string, number>();

  for (const [rel, text] of graph.texts) {
    const node = graph.nodes.get(rel)!;
    if (!["source", "test", "style", "config"].includes(node.file.fileClass)) continue;
    if (node.file.fileClass === "test" && !options.includeTests) continue;
    if (node.file.fileClass === "config" && !/\.(prisma|graphql|gql|ya?ml)$/.test(rel)) continue;

    const tokens = tokenize(text);
    const pathTerms = new Set(tokenize(rel));
    const tf = new Map<string, number>();
    for (const token of tokens) {
      if (termNames.includes(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const line of text.split("\n")) {
      if (line.length > 300 || !SYMBOL_LINE.test(line)) continue;
      for (const token of tokenize(line)) {
        if (termNames.includes(token)) tf.set(token, (tf.get(token) ?? 0) + SYMBOL_BOOST);
      }
    }
    for (const term of pathTerms) {
      if (termNames.includes(term)) tf.set(term, (tf.get(term) ?? 0) + PATH_BOOST);
    }
    if (tf.size === 0) continue;
    for (const term of tf.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    docs.push({ rel, length: tokens.length, tf, pathTerms });
  }

  const count = docs.length || 1;
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / count || 1;
  const scored = docs
    .map((doc) => {
      let score = 0;
      for (const { term, weight } of terms) {
        const frequency = doc.tf.get(term);
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 1;
        const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
        score +=
          weight *
          idf *
          ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * doc.length) / averageLength)));
      }
      return { ...doc, score };
    })
    .sort((a, b) => b.score - a.score);

  const limit = options.limit ?? 25;
  const hits: SearchHit[] = scored.slice(0, limit).map((doc) => {
    const lines = graph.texts.get(doc.rel)!.split("\n");
    const highlights: { line: number; text: string }[] = [];
    for (let index = 0; index < lines.length && highlights.length < 3; index++) {
      const line = lines[index]!;
      if (line.length > 240) continue;
      if (tokenize(line).some((token) => termNames.includes(token))) {
        highlights.push({ line: index + 1, text: sanitizeDisplay(line.trim()) });
      }
    }
    return {
      path: doc.rel,
      score: Math.round(doc.score * 100) / 100,
      file_class: graph.nodes.get(doc.rel)!.file.fileClass,
      matched_terms: [...doc.tf.keys()],
      fan_in: productionFanIn(graph, doc.rel),
      highlights,
    };
  });

  const byDirectory = new Map<string, { score: number; files: string[] }>();
  for (const doc of scored.slice(0, 80)) {
    const directory = path.posix.dirname(doc.rel);
    const entry = byDirectory.get(directory) ?? { score: 0, files: [] };
    entry.score += doc.score;
    entry.files.push(doc.rel);
    byDirectory.set(directory, entry);
  }
  const clusters = [...byDirectory.entries()]
    .map(([directory, entry]) => ({
      directory,
      score: Math.round(entry.score * 100) / 100,
      files: entry.files.slice(0, 12),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const fanInCeiling = Math.max(10, graph.files.length * 0.05);
  const suggested = hits
    .filter(
      (hit) => hit.file_class === "source" && hit.fan_in < fanInCeiling && !DATA_DEFINITION.test(hit.path),
    )
    .slice(0, 5)
    .map((hit) => hit.path);

  return { terms: termNames, hits, clusters, suggested_seeds: suggested, indexed_files: docs.length };
}
