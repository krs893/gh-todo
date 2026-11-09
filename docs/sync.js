// 純粋関数群（並び替え・統合・Base64・ローカル日付）
// DOM や fetch には一切依存しない

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * Date オブジェクトから端末のローカル日付 (YYYY-MM-DD) を返す。
 * toISOString() は UTC になり日付がずれるため使用しない。
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * YYYY-MM-DD 文字列をローカルの Date (00:00:00) に変換する。
 * @param {string} dateStr
 * @returns {Date | null}
 */
export function parseLocalDate(dateStr) {
  if (typeof dateStr !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

/**
 * 期限が今日かどうか判定する。
 * @param {string | null | undefined} due
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {boolean}
 */
export function isToday(due, todayStr = formatLocalDate()) {
  if (!due) return false;
  return due === todayStr;
}

/**
 * 期限切れ（due < 今日）かどうか判定する。
 * @param {string | null | undefined} due
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {boolean}
 */
export function isOverdue(due, todayStr = formatLocalDate()) {
  if (!due) return false;
  return due < todayStr;
}

/**
 * 期限を「今日」「明日」「11/12(水)」のように人間向けに整形する。
 * @param {string | null | undefined} due
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {string}
 */
export function formatDueLabel(due, todayStr = formatLocalDate()) {
  if (!due) return "";
  if (due === todayStr) return "今日";

  const todayDate = parseLocalDate(todayStr);
  const dueDate = parseLocalDate(due);
  if (!dueDate) return due;

  if (todayDate) {
    const tomorrowDate = new Date(
      todayDate.getFullYear(),
      todayDate.getMonth(),
      todayDate.getDate() + 1
    );
    if (formatLocalDate(tomorrowDate) === due) {
      return "明日";
    }
  }

  const month = dueDate.getMonth() + 1;
  const day = dueDate.getDate();
  const weekday = WEEKDAYS_JA[dueDate.getDay()];
  if (todayDate && dueDate.getFullYear() !== todayDate.getFullYear()) {
    return `${dueDate.getFullYear()}/${month}/${day}(${weekday})`;
  }
  return `${month}/${day}(${weekday})`;
}

/**
 * タスクの並び順グループ番号を返す。
 * 1: 期限切れ（due < 今日）
 * 2: 今日（today が true、または due が今日）
 * 3: 今後（due > 今日）
 * 4: 期限なし
 * @param {object} todo
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {number}
 */
export function getTodoGroup(todo, todayStr = formatLocalDate()) {
  const due = todo?.due || null;
  const todayFlag = Boolean(todo?.today);

  if (due && due < todayStr) {
    return 1;
  }
  if (todayFlag || (due && due === todayStr)) {
    return 2;
  }
  if (due && due > todayStr) {
    return 3;
  }
  return 4;
}

/**
 * 2つの Todo を仕様の優先順に従って比較する。
 * - グループ順 (1: 期限切れ -> 2: 今日 -> 3: 今後 -> 4: 期限なし)
 * - 同じグループ内は today が true のものを先
 * - 次に due 昇順（due があるものを null より先）
 * - 次に updatedAt 降順
 * @param {object} a
 * @param {object} b
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {number}
 */
export function compareTodos(a, b, todayStr = formatLocalDate()) {
  const doneA = Boolean(a?.done);
  const doneB = Boolean(b?.done);
  if (doneA !== doneB) {
    return doneA ? 1 : -1;
  }

  const groupA = getTodoGroup(a, todayStr);
  const groupB = getTodoGroup(b, todayStr);
  if (groupA !== groupB) {
    return groupA - groupB;
  }

  const todayA = Boolean(a?.today);
  const todayB = Boolean(b?.today);
  if (todayA !== todayB) {
    return todayA ? -1 : 1;
  }

  const dueA = a?.due || null;
  const dueB = b?.due || null;
  if (dueA !== dueB) {
    if (dueA === null) return 1;
    if (dueB === null) return -1;
    return dueA < dueB ? -1 : 1;
  }

  const updatedA = a?.updatedAt || "";
  const updatedB = b?.updatedAt || "";
  if (updatedA !== updatedB) {
    return updatedB < updatedA ? -1 : 1;
  }

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/**
 * Todo 配列を仕様どおりの並び順でソートした新しい配列を返す。
 * @param {Array<object>} todos
 * @param {string} [todayStr=formatLocalDate()]
 * @returns {Array<object>}
 */
export function sortTodos(todos, todayStr = formatLocalDate()) {
  if (!Array.isArray(todos)) return [];
  return [...todos].sort((a, b) => compareTodos(a, b, todayStr));
}

/**
 * 最新の base（GitHub の内容）の上に、手元でまだ送っていない pending の変更だけを重ねる。
 * - upsert: 同じ id が base にあれば、base側.updatedAt > pending側.updatedAt のときだけ base を残し、
 *   それ以外は pending で置き換える。無ければ追加。
 * - delete: base から同じ id を取り除く（無ければ何もしない）。
 * @param {Array<object>} base
 * @param {Record<string, { type: "upsert", todo: object } | { type: "delete" }>} pending
 * @returns {Array<object>}
 */
export function applyPending(base = [], pending = {}) {
  const safeBase = Array.isArray(base) ? base : [];
  const safePending = pending && typeof pending === "object" ? pending : {};
  const seenIds = new Set();
  const result = [];

  for (const baseTodo of safeBase) {
    if (!baseTodo || typeof baseTodo.id !== "string") continue;
    const id = baseTodo.id;
    seenIds.add(id);
    const entry = safePending[id];

    if (!entry) {
      result.push({ ...baseTodo, tags: Array.isArray(baseTodo.tags) ? [...baseTodo.tags] : [] });
      continue;
    }

    if (entry.type === "delete") {
      continue;
    }

    if (entry.type === "upsert" && entry.todo) {
      const baseUpdated = String(baseTodo.updatedAt || "");
      const pendingUpdated = String(entry.todo.updatedAt || "");
      if (baseUpdated > pendingUpdated) {
        result.push({ ...baseTodo, tags: Array.isArray(baseTodo.tags) ? [...baseTodo.tags] : [] });
      } else {
        result.push({
          ...entry.todo,
          tags: Array.isArray(entry.todo.tags) ? [...entry.todo.tags] : [],
        });
      }
      continue;
    }

    result.push({ ...baseTodo, tags: Array.isArray(baseTodo.tags) ? [...baseTodo.tags] : [] });
  }

  for (const [id, entry] of Object.entries(safePending)) {
    if (seenIds.has(id)) continue;
    if (entry && entry.type === "upsert" && entry.todo) {
      result.push({
        ...entry.todo,
        id: entry.todo.id || id,
        tags: Array.isArray(entry.todo.tags) ? [...entry.todo.tags] : [],
      });
    }
  }

  return result;
}

/**
 * 送った時点の sentPending のうち、その後 currentPending で変わっていないものだけ消した新しい pending を返す。
 * @param {Record<string, any>} currentPending
 * @param {Record<string, any>} sentPending
 * @returns {Record<string, any>}
 */
export function pruneResolvedPending(currentPending = {}, sentPending = {}) {
  const next = {};
  for (const [id, currentEntry] of Object.entries(currentPending || {})) {
    const sentEntry = sentPending?.[id];
    if (!sentEntry) {
      next[id] = currentEntry;
      continue;
    }
    if (currentEntry.type !== sentEntry.type) {
      next[id] = currentEntry;
      continue;
    }
    if (currentEntry.type === "delete") {
      // delete のまま変わっていなければ消す
      continue;
    }
    if (currentEntry.type === "upsert") {
      const currTodo = currentEntry.todo || {};
      const sentTodo = sentEntry.todo || {};
      const sameUpdated = currTodo.updatedAt === sentTodo.updatedAt;
      const sameContent = JSON.stringify(currTodo) === JSON.stringify(sentTodo);
      if (!sameUpdated || !sameContent) {
        next[id] = currentEntry;
      }
    }
  }
  return next;
}

/**
 * 完了済みタスクの delete を pending に積んだ新しい pending を返す。
 * @param {Array<object>} todos
 * @param {Record<string, any>} [currentPending={}]
 * @returns {Record<string, any>}
 */
export function buildClearCompletedPending(todos = [], currentPending = {}) {
  const next = { ...(currentPending || {}) };
  for (const todo of todos) {
    if (todo && todo.done && todo.id) {
      next[todo.id] = { type: "delete" };
    }
  }
  return next;
}

/**
 * UTF-8 文字列を Base64 にエンコードする（TextEncoder 経由）。
 * @param {string} str
 * @returns {string}
 */
export function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Base64 文字列（改行を含む場合あり）を UTF-8 文字列にデコードする（TextDecoder 経由）。
 * @param {string} b64
 * @returns {string}
 */
export function decodeBase64Utf8(b64) {
  const cleaned = String(b64 ?? "").replace(/\s+/g, "");
  if (!cleaned) return "";
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * todos 配列を GitHub 保存用の JSON 文字列（2スペースインデント + 末尾改行）に変換する。
 * @param {Array<object>} todos
 * @returns {string}
 */
export function serializeTodosJson(todos) {
  const safeTodos = Array.isArray(todos) ? todos : [];
  return JSON.stringify({ todos: safeTodos }, null, 2) + "\n";
}

/**
 * JSON 文字列から todos 配列を取り出す。
 * @param {string} jsonStr
 * @returns {Array<object>}
 */
export function parseTodosJson(jsonStr) {
  if (!jsonStr || !String(jsonStr).trim()) {
    return [];
  }
  const parsed = JSON.parse(jsonStr);
  if (!parsed || !Array.isArray(parsed.todos)) {
    return [];
  }
  return parsed.todos;
}

/**
 * カンマ・読点区切りのタグ文字列を配列に正規化する。
 * @param {string} raw
 * @returns {Array<string>}
 */
export function parseTagsInput(raw) {
  if (!raw || typeof raw !== "string") return [];
  const seen = new Set();
  const tags = [];
  for (const part of raw.split(/[,、]/)) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}
