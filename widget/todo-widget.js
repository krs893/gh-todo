// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: check-square;

// ==========================================
// Todo - Scriptable Widget
// ==========================================

const OWNER = "krs893";
const REPO = "gh-todo-data";
const PATH = "todos.json";
const BRANCH = "main";
const APP_URL = "https://krs893.github.io/gh-todo/";

const TOKEN_KEY = "gh_todo_token";
const CACHE_FILENAME = "gh-todo-widget-cache.json";
const REFRESH_INTERVAL_MS = 60 * 1000; // 1分後以降の更新を要求。実際の更新時刻は iOS が決める。
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

// --- 日付・並び替え（sync.js と同一規則） ---

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateStr) {
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

function formatDueLabel(due, todayStr = formatLocalDate()) {
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

function getTodoGroup(todo, todayStr = formatLocalDate()) {
  const due = todo?.due || null;
  const todayFlag = Boolean(todo?.today);

  if (due && due < todayStr) return 1; // 期限切れ
  if (todayFlag || (due && due === todayStr)) return 2; // 今日
  if (due && due > todayStr) return 3; // 今後
  return 4; // 期限なし
}

function compareTodos(a, b, todayStr = formatLocalDate()) {
  const doneA = Boolean(a?.done);
  const doneB = Boolean(b?.done);
  if (doneA !== doneB) return doneA ? 1 : -1;

  const groupA = getTodoGroup(a, todayStr);
  const groupB = getTodoGroup(b, todayStr);
  if (groupA !== groupB) return groupA - groupB;

  const todayA = Boolean(a?.today);
  const todayB = Boolean(b?.today);
  if (todayA !== todayB) return todayA ? -1 : 1;

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

function sortTodos(todos, todayStr = formatLocalDate()) {
  if (!Array.isArray(todos)) return [];
  return [...todos].sort((a, b) => compareTodos(a, b, todayStr));
}

function formatTimeHHMM(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// --- Keychain トークン管理 ---

async function ensureToken() {
  if (Keychain.contains(TOKEN_KEY)) {
    const existing = Keychain.get(TOKEN_KEY);
    if (existing && existing.trim()) {
      return existing.trim();
    }
  }

  if (config.runsInWidget) {
    return null;
  }

  const alert = new Alert();
  alert.title = "GitHub トークン設定";
  alert.message =
    "データ用リポジトリの Contents (Read-only) 権限を持つ Fine-grained PAT を入力してください。";
  alert.addSecureTextField("github_pat_...", "");
  alert.addAction("保存");
  alert.addCancelAction("キャンセル");

  const idx = await alert.presentAlert();
  if (idx === -1) return null;

  const entered = alert.textFieldValue(0).trim();
  if (!entered) return null;

  Keychain.set(TOKEN_KEY, entered);
  return entered;
}

// --- キャッシュと GitHub 取得 ---

function getCacheFilePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILENAME);
}

function readLocalCache() {
  const fm = FileManager.local();
  const path = getCacheFilePath();
  if (!fm.fileExists(path)) {
    return { todos: [], fetchedAt: null };
  }
  try {
    const raw = fm.readString(path);
    const parsed = JSON.parse(raw);
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      fetchedAt: parsed.fetchedAt || null,
    };
  } catch {
    return { todos: [], fetchedAt: null };
  }
}

function writeLocalCache(todos, fetchedAt) {
  const fm = FileManager.local();
  const path = getCacheFilePath();
  fm.writeString(path, JSON.stringify({ todos, fetchedAt }, null, 2));
}

async function fetchTodosWithCache(token) {
  const encodedPath = PATH.replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(
    OWNER
  )}/${encodeURIComponent(REPO)}/contents/${encodedPath}?ref=${encodeURIComponent(
    BRANCH
  )}`;

  const req = new Request(url);
  req.method = "GET";
  req.headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  req.timeoutInterval = 15;

  try {
    const rawText = await req.loadString();
    const statusCode = req.response?.statusCode || 200;

    // 404 はファイル未作成のほか、トークンに権限がない場合にも返るため、空として扱わず失敗にする
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP ${statusCode}`);
    }

    const parsed = JSON.parse(rawText);
    const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
    const now = new Date().toISOString();
    writeLocalCache(todos, now);
    return { todos, fetchedAt: now, failed: false };
  } catch {
    const cached = readLocalCache();
    return {
      todos: cached.todos,
      fetchedAt: cached.fetchedAt,
      failed: true,
    };
  }
}

// --- ウィジェット組み立て ---

function createTokenMissingWidget() {
  const widget = new ListWidget();
  widget.url = APP_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_INTERVAL_MS);
  const text = widget.addText("Scriptableで一度実行してトークンを設定");
  text.font = Font.mediumSystemFont(13);
  text.textColor = Color.orange();
  return widget;
}

function populateLockScreenWidget(widget, family, activeTodos, todayStr, failed) {
  const focusTodos = activeTodos.filter((t) => getTodoGroup(t, todayStr) <= 2);
  const nextTodo = activeTodos[0] || null;

  if (family === "accessoryInline") {
    if (!nextTodo) {
      widget.addText("☑ タスクなし");
    } else {
      widget.addText(`☑ 今日${focusTodos.length}件: ${nextTodo.title}`);
    }
    return;
  }

  if (family === "accessoryCircular") {
    const stack = widget.addStack();
    stack.layoutVertically();
    stack.centerAlignContent();

    const countText = stack.addText(String(focusTodos.length));
    countText.font = Font.boldSystemFont(20);
    countText.centerAlignText();

    const labelText = stack.addText("今日");
    labelText.font = Font.systemFont(10);
    labelText.centerAlignText();
    return;
  }

  // accessoryRectangular
  const header = widget.addText(
    `Todo · 今日 ${focusTodos.length}件 / 全${activeTodos.length}件${
      failed ? " (!)" : ""
    }`
  );
  header.font = Font.boldSystemFont(11);
  widget.addSpacer(2);

  if (activeTodos.length === 0) {
    const empty = widget.addText("未完了のタスクはありません");
    empty.font = Font.systemFont(12);
    return;
  }

  for (const todo of activeTodos.slice(0, 2)) {
    const dueLabel = formatDueLabel(todo.due, todayStr);
    const prefix = dueLabel ? `[${dueLabel}] ` : todo.today ? "[今日] " : "";
    const line = widget.addText(`• ${prefix}${todo.title}`);
    line.font = Font.systemFont(12);
    line.lineLimit = 1;
  }
}

function populateHomeScreenWidget(
  widget,
  family,
  activeTodos,
  todayStr,
  fetchedAt,
  failed
) {
  const bgColor = Color.dynamic(new Color("#ffffff"), new Color("#1e293b"));
  const textColor = Color.dynamic(new Color("#0f172a"), new Color("#f8fafc"));
  const mutedColor = Color.dynamic(new Color("#64748b"), new Color("#94a3b8"));
  const accentColor = Color.dynamic(new Color("#2563eb"), new Color("#60a5fa"));
  const dangerColor = Color.dynamic(new Color("#dc2626"), new Color("#f87171"));

  const layout = family === "small"
    ? { taskFont: 14, dueFont: 11, countFont: 12, rowSpacing: 5, maxItems: 3, titleLines: 1, padding: 12 }
    : family === "medium"
    ? { taskFont: 15, dueFont: 12, countFont: 13, rowSpacing: 4, maxItems: 4, titleLines: 1, padding: 12 }
    : { taskFont: 18, dueFont: 14, countFont: 14, rowSpacing: 10, maxItems: 5, titleLines: 2, padding: 16 };

  widget.backgroundColor = bgColor;
  widget.setPadding(layout.padding, 14, layout.padding, 14);

  // ヘッダー
  const headerRow = widget.addStack();
  headerRow.layoutHorizontally();
  headerRow.centerAlignContent();

  const titleText = headerRow.addText("Todo");
  titleText.font = Font.boldSystemFont(16);
  titleText.textColor = accentColor;

  headerRow.addSpacer();

  const countText = headerRow.addText(`${activeTodos.length}件`);
  countText.font = Font.semiboldSystemFont(layout.countFont);
  countText.textColor = mutedColor;

  widget.addSpacer(family === "small" ? 8 : 10);

  const displayTodos = activeTodos.slice(0, layout.maxItems);

  if (displayTodos.length === 0) {
    widget.addSpacer();
    const emptyText = widget.addText("未完了のタスクはありません");
    emptyText.font = Font.systemFont(layout.taskFont);
    emptyText.textColor = mutedColor;
    widget.addSpacer();
  } else {
    for (const todo of displayTodos) {
      const row = widget.addStack();
      row.layoutHorizontally();
      row.centerAlignContent();

      const isOverdueItem = Boolean(todo.due && todo.due < todayStr);
      const bullet = row.addText(todo.today ? "★ " : "• ");
      bullet.font = Font.boldSystemFont(layout.taskFont);
      bullet.textColor = isOverdueItem
        ? dangerColor
        : todo.today
        ? accentColor
        : mutedColor;

      const title = row.addText(todo.title);
      title.font = Font.systemFont(layout.taskFont);
      title.textColor = textColor;
      title.lineLimit = layout.titleLines;

      row.addSpacer(4);

      const dueLabel = formatDueLabel(todo.due, todayStr);
      if (dueLabel) {
        const dueText = row.addText(dueLabel);
        dueText.font = Font.semiboldSystemFont(layout.dueFont);
        dueText.textColor = isOverdueItem
          ? dangerColor
          : todo.due === todayStr
          ? accentColor
          : mutedColor;
      }

      widget.addSpacer(layout.rowSpacing);
    }
    widget.addSpacer();
  }

  // フッター（最終取得時刻 / 取得失敗）
  const footerRow = widget.addStack();
  footerRow.layoutHorizontally();
  footerRow.centerAlignContent();

  const timeLabel = formatTimeHHMM(fetchedAt);
  const statusStr = failed
    ? `取得失敗${timeLabel ? ` (${timeLabel})` : ""}`
    : timeLabel
    ? `更新 ${timeLabel}`
    : "";

  const footerText = footerRow.addText(statusStr);
  footerText.font = Font.systemFont(12);
  footerText.textColor = failed ? dangerColor : mutedColor;
}

async function run() {
  const token = await ensureToken();
  if (!token) {
    const missingWidget = createTokenMissingWidget();
    if (config.runsInWidget) {
      Script.setWidget(missingWidget);
    } else {
      await missingWidget.presentMedium();
    }
    Script.complete();
    return;
  }

  const { todos, fetchedAt, failed } = await fetchTodosWithCache(token);
  const todayStr = formatLocalDate();
  const activeTodos = sortTodos(
    todos.filter((t) => !t.done && !t.deletedAt),
    todayStr
  );

  const widget = new ListWidget();
  widget.url = APP_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_INTERVAL_MS);

  const family = config.widgetFamily || "medium";
  if (
    family === "accessoryRectangular" ||
    family === "accessoryInline" ||
    family === "accessoryCircular"
  ) {
    populateLockScreenWidget(widget, family, activeTodos, todayStr, failed);
  } else {
    populateHomeScreenWidget(
      widget,
      family,
      activeTodos,
      todayStr,
      fetchedAt,
      failed
    );
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

await run();
