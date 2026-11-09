// GitHub Contents API の読み書き
import {
  decodeBase64Utf8,
  encodeBase64Utf8,
  parseTodosJson,
  serializeTodosJson,
} from "./sync.js";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {any} [details]
   */
  constructor(message, status, details = null) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.details = details;
  }
}

/**
 * 設定オブジェクトが通信可能な必須項目を備えているか検証する。
 * @param {object} config
 * @returns {boolean}
 */
export function isConfigValid(config) {
  return Boolean(
    config &&
      typeof config.owner === "string" &&
      config.owner.trim() &&
      typeof config.repo === "string" &&
      config.repo.trim() &&
      typeof config.token === "string" &&
      config.token.trim()
  );
}

function buildContentsUrl(config, includeRef = false) {
  const owner = encodeURIComponent(config.owner.trim());
  const repo = encodeURIComponent(config.repo.trim());
  const rawPath = (config.path || "todos.json").trim().replace(/^\/+/, "");
  const encodedPath = rawPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const branch = (config.branch || "main").trim();

  const base = `${API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`;
  if (includeRef) {
    return `${base}?ref=${encodeURIComponent(branch)}`;
  }
  return base;
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

/**
 * GitHub から todos.json を取得する。
 * 404（ファイル未作成）の場合は { todos: [], sha: null } を返す。
 * @param {{ owner: string, repo: string, path?: string, branch?: string, token: string }} config
 * @returns {Promise<{ todos: Array<object>, sha: string | null }>}
 */
export async function fetchTodosFromGitHub(config) {
  if (!isConfigValid(config)) {
    throw new GitHubApiError("GitHub 設定が未入力です", 0);
  }

  const url = buildContentsUrl(config, true);
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(config.token),
    cache: "no-store",
  });

  if (response.status === 404) {
    return { todos: [], sha: null };
  }

  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {
      // ignore json parse failure
    }
    const msg =
      errorBody?.message || `GitHub GET エラー (HTTP ${response.status})`;
    throw new GitHubApiError(msg, response.status, errorBody);
  }

  const data = await response.json();
  const decoded = decodeBase64Utf8(data.content || "");
  const todos = parseTodosJson(decoded);
  return {
    todos,
    sha: data.sha || null,
  };
}

/**
 * GitHub の todos.json を PUT で更新（または初回作成）する。
 * @param {{ owner: string, repo: string, path?: string, branch?: string, token: string }} config
 * @param {{ todos: Array<object>, sha?: string | null }} params
 * @returns {Promise<{ sha: string }>}
 */
export async function putTodosToGitHub(config, { todos, sha }) {
  if (!isConfigValid(config)) {
    throw new GitHubApiError("GitHub 設定が未入力です", 0);
  }

  const url = buildContentsUrl(config, false);
  const jsonText = serializeTodosJson(todos);
  const bodyObj = {
    message: "Update todos",
    content: encodeBase64Utf8(jsonText),
    branch: (config.branch || "main").trim() || "main",
  };
  if (sha) {
    bodyObj.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: buildHeaders(config.token),
    cache: "no-store",
    body: JSON.stringify(bodyObj),
  });

  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {
      // ignore json parse failure
    }
    const msg =
      errorBody?.message || `GitHub PUT エラー (HTTP ${response.status})`;
    throw new GitHubApiError(msg, response.status, errorBody);
  }

  const data = await response.json();
  const nextSha = data?.content?.sha || null;
  return { sha: nextSha };
}
