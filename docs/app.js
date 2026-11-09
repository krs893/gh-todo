// UI・状態管理・ポーリング・同期制御
import {
  applyPending,
  buildClearCompletedPending,
  compareTodos,
  formatDueLabel,
  formatLocalDate,
  getTodoGroup,
  isOverdue,
  isToday,
  parseTagsInput,
  pruneResolvedPending,
  sortTodos,
} from "./sync.js";
import {
  fetchTodosFromGitHub,
  isConfigValid,
  putTodosToGitHub,
} from "./github.js";

// GitHub Pages では同じユーザーの他のプロジェクトとオリジンを共有するため、キーに接頭辞を付ける
const STORAGE_KEYS = {
  settings: "ghTodo:settings",
  cache: "ghTodo:cache",
  pending: "ghTodo:pending",
};

const DEBOUNCE_MS = 1500;
const MONITOR_POLL_MS = 45 * 1000;
const MONITOR_STALE_MS = 5 * 60 * 1000;
const MONITOR_UPCOMING_LIMIT = 8;
const MAX_CONFLICT_RETRIES = 3;

// --- アプリ状態 ---
let settings = loadSettings();
let cache = loadCache();
let pending = loadPending();

let selectedTag = null;
let editingTodoId = null;
let editingDraft = null; // 編集中フィールドの一時保持

let isSaving = false;
let isFetching = false;
let saveQueued = false;
let debounceTimer = null;
let syncError = null;
let lastFocusFetchAt = 0;
let cacheVersion = 0; // cache を書き換えるたびに増やし、古い GET 応答で上書きしないために使う

const isMonitorMode =
  new URLSearchParams(window.location.search).get("mode") === "monitor";

let wakeLockSentinel = null;
let monitorPollTimer = null;
let monitorStaleTimer = null;

// --- LocalStorage 読み書き ---
function loadSettings() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) {
      return {
        owner: "",
        repo: "",
        path: "todos.json",
        branch: "main",
        token: "",
      };
    }
    const parsed = JSON.parse(raw);
    return {
      owner: String(parsed.owner || "").trim(),
      repo: String(parsed.repo || "").trim(),
      path: String(parsed.path || "todos.json").trim() || "todos.json",
      branch: String(parsed.branch || "main").trim() || "main",
      token: String(parsed.token || "").trim(),
    };
  } catch {
    return {
      owner: "",
      repo: "",
      path: "todos.json",
      branch: "main",
      token: "",
    };
  }
}

function saveSettingsToStorage() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function loadCache() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEYS.cache);
    if (!raw) {
      return { todos: [], sha: null, lastSyncedAt: null };
    }
    const parsed = JSON.parse(raw);
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      sha: parsed.sha || null,
      lastSyncedAt: parsed.lastSyncedAt || null,
    };
  } catch {
    return { todos: [], sha: null, lastSyncedAt: null };
  }
}

function saveCacheToStorage() {
  localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(cache));
}

function loadPending() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEYS.pending);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePendingToStorage() {
  localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(pending));
}

function clonePending(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function getPendingCount() {
  return Object.keys(pending || {}).length;
}

/**
 * 画面に表示する現在の Todo 一覧（cache.todos に pending を重ねた結果）
 */
function getEffectiveTodos() {
  return applyPending(cache.todos, pending);
}

/**
 * ISO 日時文字列からローカル時刻 HH:MM を返す。
 * @param {string | null} isoStr
 * @returns {string}
 */
function formatTimeHHMM(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// --- 同期制御（GET / PUT） ---

/**
 * GitHub から最新を取得して cache を更新する。pending はそのまま残す。
 */
async function syncFromRemote() {
  if (!isConfigValid(settings)) {
    render();
    return;
  }
  // 保存中は取得しない（保存側が 409 時に自分で取り直す）
  if (isFetching || isSaving) return;

  isFetching = true;
  renderSyncStatus();
  const versionAtStart = cacheVersion;

  try {
    const remote = await fetchTodosFromGitHub(settings);
    // 取得中に保存が完了していたら、この応答は古いので捨てる
    if (cacheVersion !== versionAtStart) return;
    cacheVersion += 1;
    cache = {
      todos: remote.todos,
      sha: remote.sha,
      lastSyncedAt: new Date().toISOString(),
    };
    saveCacheToStorage();
    if (!isSaving && getPendingCount() === 0) {
      syncError = null;
    }
  } catch (err) {
    syncError = err;
  } finally {
    isFetching = false;
    render();
  }
}

/**
 * 変更を pending に積んだあと 1.5秒デバウンスして保存を予約する。
 */
function scheduleSave() {
  syncError = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushSave();
  }, DEBOUNCE_MS);
  render();
}

/**
 * pending の内容を GitHub に PUT 保存する。
 * - 同時に1つだけ実行（直列化）
 * - 保存中に新しい変更が来たら、終わってからもう一度保存
 * - 409 または 422 のときは GET で最新を取り直して cache を更新し、手順1からやり直す（最大3回）
 */
async function flushSave() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (!isConfigValid(settings)) {
    openSettingsModal();
    return;
  }

  if (getPendingCount() === 0) {
    renderSyncStatus();
    return;
  }

  if (isSaving) {
    saveQueued = true;
    return;
  }

  isSaving = true;
  saveQueued = false;
  syncError = null;
  renderSyncStatus();

  let retries = 0;

  try {
    while (true) {
      const sentPending = clonePending(pending);
      if (Object.keys(sentPending).length === 0) {
        break;
      }

      // 手順1: next = applyPending(cache.todos, pending) を作る
      const nextTodos = applyPending(cache.todos, sentPending);

      try {
        // 手順2: PUT
        const result = await putTodosToGitHub(settings, {
          todos: nextTodos,
          sha: cache.sha,
        });

        // 手順3: 成功時 cache を更新し、送った時点の pending のうち変わっていないものだけ消す
        const now = new Date().toISOString();
        cacheVersion += 1;
        cache = {
          todos: nextTodos,
          sha: result.sha,
          lastSyncedAt: now,
        };
        saveCacheToStorage();

        pending = pruneResolvedPending(pending, sentPending);
        savePendingToStorage();
        syncError = null;
        break;
      } catch (err) {
        // 手順4: 409 または 422（sha 不一致）は GET で最新を取り直して手順1からやり直す（最大3回）
        if (
          (err?.status === 409 || err?.status === 422) &&
          retries < MAX_CONFLICT_RETRIES
        ) {
          retries += 1;
          const remote = await fetchTodosFromGitHub(settings);
          cacheVersion += 1;
          cache = {
            todos: remote.todos,
            sha: remote.sha,
            lastSyncedAt: new Date().toISOString(),
          };
          saveCacheToStorage();
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    // 手順5: ネットワークエラー・401・403 などは pending を残したままエラー表示
    syncError = err;
  } finally {
    isSaving = false;
    render();

    // 保存中に新しい変更が来ていた場合、続けてもう一度保存（エラー停止時を除く）
    if (!syncError && (saveQueued || getPendingCount() > 0) && !debounceTimer) {
      saveQueued = false;
      flushSave();
    }
  }
}

// --- タスク操作（pending の更新） ---

function upsertTodo(todo) {
  pending[todo.id] = {
    type: "upsert",
    todo: {
      id: todo.id,
      title: String(todo.title || "").trim(),
      done: Boolean(todo.done),
      today: Boolean(todo.today),
      due: todo.due || null,
      tags: Array.isArray(todo.tags) ? [...todo.tags] : [],
      updatedAt: new Date().toISOString(),
    },
  };
  savePendingToStorage();
  scheduleSave();
}

function deleteTodo(id) {
  if (!id) return;
  pending[id] = { type: "delete" };
  if (editingTodoId === id) {
    editingTodoId = null;
    editingDraft = null;
  }
  savePendingToStorage();
  scheduleSave();
}

function clearCompletedTodos() {
  const currentTodos = getEffectiveTodos();
  const hasCompleted = currentTodos.some((t) => t.done);
  if (!hasCompleted) return;

  pending = buildClearCompletedPending(currentTodos, pending);
  savePendingToStorage();
  scheduleSave();
}

// --- UI 描画 ---

function render() {
  if (isMonitorMode) {
    renderMonitorMode();
  } else {
    renderNormalMode();
  }
}

function renderSyncStatus() {
  if (isMonitorMode) {
    renderMonitorStatus();
    return;
  }

  const badge = document.getElementById("sync-status-badge");
  const retryBtn = document.getElementById("retry-sync-btn");
  if (!badge || !retryBtn) return;

  badge.className = "sync-badge";
  retryBtn.hidden = true;
  badge.removeAttribute("title");

  if (!isConfigValid(settings)) {
    badge.textContent = "未設定";
    return;
  }

  const pendingCount = getPendingCount();

  if (isSaving) {
    badge.textContent = "保存中…";
    badge.classList.add("is-saving");
    return;
  }

  if (syncError) {
    const suffix = pendingCount > 0 ? `（未送信 ${pendingCount}件）` : "";
    badge.textContent = `エラー${suffix}`;
    badge.title = syncError.message || "同期エラーが発生しました";
    badge.classList.add("is-error");
    retryBtn.hidden = false;
    return;
  }

  if (pendingCount > 0) {
    badge.textContent = `未送信 ${pendingCount}件`;
    badge.classList.add("is-pending");
    return;
  }

  if (isFetching && !cache.lastSyncedAt) {
    badge.textContent = "同期中…";
    return;
  }

  if (cache.lastSyncedAt) {
    const timeLabel = formatTimeHHMM(cache.lastSyncedAt);
    badge.textContent = `同期済み ${timeLabel}`;
    badge.classList.add("is-synced");
  } else {
    badge.textContent = "未同期";
  }
}

function syncEditingDraftFromDOM() {
  if (!editingTodoId) return;
  const form = document.querySelector(
    `.todo-edit-form[data-edit-id="${CSS.escape(editingTodoId)}"]`
  );
  if (!form) return;
  const titleInput = form.querySelector('input[name="edit-title"]');
  const todayInput = form.querySelector('input[name="edit-today"]');
  const dueInput = form.querySelector('input[name="edit-due"]');
  const tagsInput = form.querySelector('input[name="edit-tags"]');
  if (titleInput && todayInput && dueInput && tagsInput) {
    editingDraft = {
      id: editingTodoId,
      title: titleInput.value,
      today: todayInput.checked,
      due: dueInput.value || null,
      tagsText: tagsInput.value,
    };
  }
}

function renderNormalMode() {
  renderSyncStatus();
  syncEditingDraftFromDOM();

  const todayStr = formatLocalDate();
  const allTodos = getEffectiveTodos();
  const activeTodos = sortTodos(
    allTodos.filter((t) => !t.done),
    todayStr
  );
  const completedTodos = [...allTodos.filter((t) => t.done)].sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );

  renderTagFilterBar(activeTodos);

  const filteredActive = selectedTag
    ? activeTodos.filter(
        (t) => Array.isArray(t.tags) && t.tags.includes(selectedTag)
      )
    : activeTodos;

  const listEl = document.getElementById("todo-list");
  const emptyEl = document.getElementById("empty-state");
  listEl.innerHTML = "";

  if (filteredActive.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = selectedTag
      ? `タグ「#${selectedTag}」の未完了タスクはありません`
      : "未完了のタスクはありません";
  } else {
    emptyEl.hidden = true;
    for (const todo of filteredActive) {
      listEl.appendChild(createTodoItemElement(todo, todayStr));
    }
  }

  // 完了済み欄
  const completedSection = document.getElementById("completed-section");
  const completedCountEl = document.getElementById("completed-count");
  const completedListEl = document.getElementById("completed-list");

  if (completedTodos.length === 0) {
    completedSection.hidden = true;
    completedListEl.innerHTML = "";
  } else {
    completedSection.hidden = false;
    completedCountEl.textContent = String(completedTodos.length);
    completedListEl.innerHTML = "";
    for (const todo of completedTodos) {
      completedListEl.appendChild(createCompletedItemElement(todo, todayStr));
    }
  }
}

function renderTagFilterBar(activeTodos) {
  const barEl = document.getElementById("tag-filter-bar");
  const tagSet = new Set();
  for (const todo of activeTodos) {
    if (Array.isArray(todo.tags)) {
      for (const tag of todo.tags) {
        if (tag) tagSet.add(tag);
      }
    }
  }

  const tags = Array.from(tagSet).sort((a, b) => a.localeCompare(b, "ja"));
  if (selectedTag && !tagSet.has(selectedTag)) {
    selectedTag = null;
  }

  if (tags.length === 0) {
    barEl.hidden = true;
    barEl.innerHTML = "";
    return;
  }

  barEl.hidden = false;
  barEl.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `tag-chip${selectedTag === null ? " is-active" : ""}`;
  allBtn.textContent = "すべて";
  allBtn.addEventListener("click", () => {
    selectedTag = null;
    renderNormalMode();
  });
  barEl.appendChild(allBtn);

  for (const tag of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `tag-chip${selectedTag === tag ? " is-active" : ""}`;
    chip.textContent = `#${tag}`;
    chip.addEventListener("click", () => {
      selectedTag = selectedTag === tag ? null : tag;
      renderNormalMode();
    });
    barEl.appendChild(chip);
  }
}

function createTodoItemElement(todo, todayStr) {
  const li = document.createElement("li");
  const group = getTodoGroup(todo, todayStr);
  const overdue = isOverdue(todo.due, todayStr);
  const dueToday = isToday(todo.due, todayStr);

  li.className = "todo-item";
  if (overdue) {
    li.classList.add("is-overdue");
  } else if (group === 2) {
    li.classList.add("is-today-group");
  }

  const row = document.createElement("div");
  row.className = "todo-row";

  // 完了チェックボックス
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "todo-checkbox";
  checkbox.checked = Boolean(todo.done);
  checkbox.setAttribute("aria-label", `「${todo.title}」を完了にする`);
  checkbox.addEventListener("change", () => {
    if (editingTodoId === todo.id) {
      editingTodoId = null;
      editingDraft = null;
    }
    upsertTodo({ ...todo, done: checkbox.checked });
  });

  // タイトル・バッジ領域（タップで編集開閉）
  const main = document.createElement("div");
  main.className = "todo-main";
  main.setAttribute("role", "button");
  main.setAttribute("tabindex", "0");
  main.setAttribute("aria-label", `「${todo.title}」を編集`);

  const titleDiv = document.createElement("div");
  titleDiv.className = "todo-title";
  titleDiv.textContent = todo.title;
  main.appendChild(titleDiv);

  const hasBadges =
    todo.today || todo.due || (Array.isArray(todo.tags) && todo.tags.length > 0);
  if (hasBadges) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";

    if (todo.today) {
      const todayBadge = document.createElement("span");
      todayBadge.className = "badge badge-today";
      todayBadge.textContent = "今日やる";
      meta.appendChild(todayBadge);
    }

    if (todo.due) {
      const dueBadge = document.createElement("span");
      dueBadge.className = "badge badge-due";
      const label = formatDueLabel(todo.due, todayStr);
      if (overdue) {
        dueBadge.classList.add("is-overdue");
        dueBadge.textContent = `期限切れ ${label}`;
      } else if (dueToday) {
        dueBadge.classList.add("is-today");
        dueBadge.textContent = `期限: ${label}`;
      } else {
        dueBadge.textContent = `期限: ${label}`;
      }
      meta.appendChild(dueBadge);
    }

    if (Array.isArray(todo.tags)) {
      for (const tag of todo.tags) {
        const tagBadge = document.createElement("span");
        tagBadge.className = "badge badge-tag";
        tagBadge.textContent = `#${tag}`;
        meta.appendChild(tagBadge);
      }
    }

    main.appendChild(meta);
  }

  const toggleEdit = () => {
    if (editingTodoId === todo.id) {
      editingTodoId = null;
      editingDraft = null;
    } else {
      editingTodoId = todo.id;
      editingDraft = {
        id: todo.id,
        title: todo.title,
        today: Boolean(todo.today),
        due: todo.due || "",
        tagsText: Array.isArray(todo.tags) ? todo.tags.join(", ") : "",
      };
    }
    renderNormalMode();
  };

  main.addEventListener("click", toggleEdit);
  main.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleEdit();
    }
  });

  // 削除ボタン
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "todo-delete-btn";
  delBtn.textContent = "削除";
  delBtn.setAttribute("aria-label", `「${todo.title}」を削除`);
  delBtn.addEventListener("click", () => {
    deleteTodo(todo.id);
  });

  row.appendChild(checkbox);
  row.appendChild(main);
  row.appendChild(delBtn);
  li.appendChild(row);

  // インライン編集フォーム
  if (editingTodoId === todo.id) {
    const draft =
      editingDraft && editingDraft.id === todo.id
        ? editingDraft
        : {
            id: todo.id,
            title: todo.title,
            today: Boolean(todo.today),
            due: todo.due || "",
            tagsText: Array.isArray(todo.tags) ? todo.tags.join(", ") : "",
          };

    const editForm = document.createElement("form");
    editForm.className = "todo-edit-form";
    editForm.dataset.editId = todo.id;

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.name = "edit-title";
    titleInput.className = "input-title";
    titleInput.required = true;
    titleInput.value = draft.title;

    const optionsRow = document.createElement("div");
    optionsRow.className = "add-form-options";

    const todayLabel = document.createElement("label");
    todayLabel.className = "checkbox-pill";
    const todayInput = document.createElement("input");
    todayInput.type = "checkbox";
    todayInput.name = "edit-today";
    todayInput.checked = Boolean(draft.today);
    const todaySpan = document.createElement("span");
    todaySpan.textContent = "今日やる";
    todayLabel.appendChild(todayInput);
    todayLabel.appendChild(todaySpan);

    const dueLabel = document.createElement("label");
    dueLabel.className = "field-inline";
    const dueSpan = document.createElement("span");
    dueSpan.className = "field-label";
    dueSpan.textContent = "期限";
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.name = "edit-due";
    dueInput.className = "input-date";
    dueInput.value = draft.due || "";
    dueLabel.appendChild(dueSpan);
    dueLabel.appendChild(dueInput);

    const tagsLabel = document.createElement("label");
    tagsLabel.className = "field-inline field-tags";
    const tagsSpan = document.createElement("span");
    tagsSpan.className = "field-label";
    tagsSpan.textContent = "タグ";
    const tagsInput = document.createElement("input");
    tagsInput.type = "text";
    tagsInput.name = "edit-tags";
    tagsInput.className = "input-tags";
    tagsInput.placeholder = "大学, 課題";
    tagsInput.value = draft.tagsText || "";
    tagsLabel.appendChild(tagsSpan);
    tagsLabel.appendChild(tagsInput);

    optionsRow.appendChild(todayLabel);
    optionsRow.appendChild(dueLabel);
    optionsRow.appendChild(tagsLabel);

    const actionsRow = document.createElement("div");
    actionsRow.className = "todo-edit-actions";

    const deleteInEditBtn = document.createElement("button");
    deleteInEditBtn.type = "button";
    deleteInEditBtn.className = "btn-danger-outline";
    deleteInEditBtn.textContent = "削除";
    deleteInEditBtn.addEventListener("click", () => {
      deleteTodo(todo.id);
    });

    const rightBtns = document.createElement("div");
    rightBtns.className = "todo-edit-right";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-ghost";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", () => {
      editingTodoId = null;
      editingDraft = null;
      renderNormalMode();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "更新";

    rightBtns.appendChild(cancelBtn);
    rightBtns.appendChild(saveBtn);
    actionsRow.appendChild(deleteInEditBtn);
    actionsRow.appendChild(rightBtns);

    editForm.appendChild(titleInput);
    editForm.appendChild(optionsRow);
    editForm.appendChild(actionsRow);

    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const newTitle = titleInput.value.trim();
      if (!newTitle) return;
      editingTodoId = null;
      editingDraft = null;
      upsertTodo({
        ...todo,
        title: newTitle,
        today: todayInput.checked,
        due: dueInput.value || null,
        tags: parseTagsInput(tagsInput.value),
      });
    });

    li.appendChild(editForm);
  }

  return li;
}

function createCompletedItemElement(todo, todayStr) {
  const li = document.createElement("li");
  li.className = "todo-item";

  const row = document.createElement("div");
  row.className = "todo-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "todo-checkbox";
  checkbox.checked = true;
  checkbox.setAttribute("aria-label", `「${todo.title}」を未完了に戻す`);
  checkbox.addEventListener("change", () => {
    upsertTodo({ ...todo, done: false });
  });

  const main = document.createElement("div");
  main.className = "todo-main";
  const titleDiv = document.createElement("div");
  titleDiv.className = "todo-title";
  titleDiv.textContent = todo.title;
  main.appendChild(titleDiv);

  if (todo.due || (Array.isArray(todo.tags) && todo.tags.length > 0)) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    if (todo.due) {
      const dueBadge = document.createElement("span");
      dueBadge.className = "badge badge-due";
      dueBadge.textContent = formatDueLabel(todo.due, todayStr);
      meta.appendChild(dueBadge);
    }
    if (Array.isArray(todo.tags)) {
      for (const tag of todo.tags) {
        const tagBadge = document.createElement("span");
        tagBadge.className = "badge badge-tag";
        tagBadge.textContent = `#${tag}`;
        meta.appendChild(tagBadge);
      }
    }
    main.appendChild(meta);
  }

  main.addEventListener("click", () => {
    upsertTodo({ ...todo, done: false });
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "todo-delete-btn";
  delBtn.textContent = "削除";
  delBtn.addEventListener("click", () => {
    deleteTodo(todo.id);
  });

  row.appendChild(checkbox);
  row.appendChild(main);
  row.appendChild(delBtn);
  li.appendChild(row);
  return li;
}

// --- モニターモード描画 & Wake Lock ---

function renderMonitorStatus() {
  const timeEl = document.getElementById("monitor-sync-time");
  const staleBadge = document.getElementById("monitor-stale-badge");
  const dateHeading = document.getElementById("monitor-date-heading");
  if (!timeEl || !staleBadge) return;

  const now = new Date();
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  if (dateHeading) {
    dateHeading.textContent = `${now.getMonth() + 1}/${now.getDate()}(${
      weekdays[now.getDay()]
    }) のタスク`;
  }

  if (!cache.lastSyncedAt) {
    timeEl.textContent = isConfigValid(settings) ? "最終取得: 未取得" : "未設定";
    staleBadge.hidden = false;
    staleBadge.textContent = syncError ? "取得エラー・古い内容" : "古い内容";
    return;
  }

  const timeLabel = formatTimeHHMM(cache.lastSyncedAt);
  timeEl.textContent = `最終取得 ${timeLabel}`;

  const elapsedMs = Date.now() - new Date(cache.lastSyncedAt).getTime();
  const isStale = elapsedMs >= MONITOR_STALE_MS || Boolean(syncError);
  staleBadge.hidden = !isStale;
  if (isStale) {
    staleBadge.textContent = syncError
      ? "古い内容（取得エラー）"
      : "古い内容（5分以上経過）";
  }
}

function renderMonitorMode() {
  renderMonitorStatus();

  const todayStr = formatLocalDate();
  const activeTodos = sortTodos(
    getEffectiveTodos().filter((t) => !t.done),
    todayStr
  );

  // 上段: 「今日やる / 今日が期限 / 期限切れ」(group 1 または group 2)
  const focusTodos = activeTodos.filter(
    (t) => getTodoGroup(t, todayStr) <= 2
  );
  // 下段: 「今後・その他」(group 3 または group 4)
  const upcomingTodos = activeTodos.filter(
    (t) => getTodoGroup(t, todayStr) >= 3
  );

  const focusCountEl = document.getElementById("monitor-focus-count");
  const focusListEl = document.getElementById("monitor-focus-list");
  const focusEmptyEl = document.getElementById("monitor-focus-empty");

  focusCountEl.textContent = `${focusTodos.length}件`;
  focusListEl.innerHTML = "";

  if (focusTodos.length === 0) {
    focusEmptyEl.hidden = false;
  } else {
    focusEmptyEl.hidden = true;
    for (const todo of focusTodos) {
      const li = document.createElement("li");
      const overdue = isOverdue(todo.due, todayStr);
      li.className = `monitor-focus-item${overdue ? " is-overdue" : ""}`;

      const titleSpan = document.createElement("span");
      titleSpan.className = "monitor-focus-title";
      titleSpan.textContent = todo.title;

      const badgesDiv = document.createElement("div");
      badgesDiv.className = "monitor-item-badges";

      if (todo.due) {
        const dueSpan = document.createElement("span");
        const label = formatDueLabel(todo.due, todayStr);
        if (overdue) {
          dueSpan.className = "monitor-badge is-overdue";
          dueSpan.textContent = `期限切れ ${label}`;
        } else {
          dueSpan.className = "monitor-badge is-today";
          dueSpan.textContent = label;
        }
        badgesDiv.appendChild(dueSpan);
      }

      if (todo.today) {
        const todaySpan = document.createElement("span");
        todaySpan.className = "monitor-badge is-today-flag";
        todaySpan.textContent = "今日やる";
        badgesDiv.appendChild(todaySpan);
      }

      if (Array.isArray(todo.tags)) {
        for (const tag of todo.tags) {
          const tagSpan = document.createElement("span");
          tagSpan.className = "monitor-badge is-tag";
          tagSpan.textContent = `#${tag}`;
          badgesDiv.appendChild(tagSpan);
        }
      }

      li.appendChild(titleSpan);
      li.appendChild(badgesDiv);
      focusListEl.appendChild(li);
    }
  }

  const upcomingCountEl = document.getElementById("monitor-upcoming-count");
  const upcomingListEl = document.getElementById("monitor-upcoming-list");
  const upcomingEmptyEl = document.getElementById("monitor-upcoming-empty");

  upcomingListEl.innerHTML = "";
  const shownUpcoming = upcomingTodos.slice(0, MONITOR_UPCOMING_LIMIT);
  const restCount = upcomingTodos.length - shownUpcoming.length;
  upcomingCountEl.textContent =
    restCount > 0
      ? `全${upcomingTodos.length}件（上位${shownUpcoming.length}件を表示）`
      : `${upcomingTodos.length}件`;

  if (shownUpcoming.length === 0) {
    upcomingEmptyEl.hidden = false;
  } else {
    upcomingEmptyEl.hidden = true;
    for (const todo of shownUpcoming) {
      const li = document.createElement("li");
      li.className = "monitor-upcoming-item";

      const titleSpan = document.createElement("span");
      titleSpan.className = "monitor-upcoming-title";
      titleSpan.textContent = todo.title;

      const rightSpan = document.createElement("span");
      rightSpan.className = "monitor-upcoming-due";
      const parts = [];
      if (todo.due) {
        parts.push(formatDueLabel(todo.due, todayStr));
      } else {
        parts.push("期限なし");
      }
      if (Array.isArray(todo.tags) && todo.tags.length > 0) {
        parts.push(todo.tags.map((t) => `#${t}`).join(" "));
      }
      rightSpan.textContent = parts.join(" · ");

      li.appendChild(titleSpan);
      li.appendChild(rightSpan);
      upcomingListEl.appendChild(li);
    }
  }
}

async function requestMonitorWakeLock() {
  if (!isMonitorMode) return;
  if (!("wakeLock" in navigator)) return;
  if (document.visibilityState !== "visible") return;
  if (wakeLockSentinel) return;

  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch {
    wakeLockSentinel = null;
  }
}

async function releaseMonitorWakeLock() {
  if (!wakeLockSentinel) return;
  try {
    await wakeLockSentinel.release();
  } catch {
    // ignore release errors
  } finally {
    wakeLockSentinel = null;
  }
}

// --- 設定モーダル制御 ---

function openSettingsModal() {
  const modal = document.getElementById("settings-modal");
  document.getElementById("setting-owner").value = settings.owner || "";
  document.getElementById("setting-repo").value = settings.repo || "";
  document.getElementById("setting-path").value = settings.path || "todos.json";
  document.getElementById("setting-branch").value = settings.branch || "main";

  const tokenInput = document.getElementById("setting-token");
  const toggleBtn = document.getElementById("toggle-token-btn");
  tokenInput.type = "password";
  tokenInput.value = settings.token || "";
  toggleBtn.textContent = "表示";

  modal.hidden = false;
}

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  modal.hidden = true;
}

// --- Service Worker 登録と更新通知 ---

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let waitingWorker = null;
  const banner = document.getElementById("sw-update-banner");
  const reloadBtn = document.getElementById("sw-reload-btn");

  const showUpdateBanner = (worker) => {
    waitingWorker = worker;
    banner.hidden = false;
  };

  reloadBtn?.addEventListener("click", () => {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });

  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      if (registration.waiting) {
        showUpdateBanner(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (
            newWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            showUpdateBanner(newWorker);
          }
        });
      });
    })
    .catch(() => {
      // Service Worker 登録失敗時は無視して通常動作を継続
    });
}

// --- 初期化 ---

function init() {
  const normalView = document.getElementById("normal-view");
  const monitorView = document.getElementById("monitor-view");

  if (isMonitorMode) {
    normalView.hidden = true;
    monitorView.hidden = false;
    document.title = "Todo (モニター)";
  } else {
    normalView.hidden = false;
    monitorView.hidden = true;
  }

  // イベントバインド: 設定モーダル
  document
    .getElementById("open-settings-btn")
    ?.addEventListener("click", openSettingsModal);
  document
    .getElementById("monitor-settings-btn")
    ?.addEventListener("click", openSettingsModal);
  document
    .getElementById("close-settings-btn")
    ?.addEventListener("click", closeSettingsModal);
  document
    .getElementById("cancel-settings-btn")
    ?.addEventListener("click", closeSettingsModal);

  document
    .getElementById("toggle-token-btn")
    ?.addEventListener("click", () => {
      const tokenInput = document.getElementById("setting-token");
      const toggleBtn = document.getElementById("toggle-token-btn");
      if (tokenInput.type === "password") {
        tokenInput.type = "text";
        toggleBtn.textContent = "隠す";
      } else {
        tokenInput.type = "password";
        toggleBtn.textContent = "表示";
      }
    });

  document.getElementById("settings-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    settings = {
      owner: document.getElementById("setting-owner").value.trim(),
      repo: document.getElementById("setting-repo").value.trim(),
      path:
        document.getElementById("setting-path").value.trim() || "todos.json",
      branch:
        document.getElementById("setting-branch").value.trim() || "main",
      token: document.getElementById("setting-token").value.trim(),
    };
    saveSettingsToStorage();
    closeSettingsModal();
    syncError = null;
    render();
    syncFromRemote().then(() => {
      if (getPendingCount() > 0) {
        flushSave();
      }
    });
  });

  // イベントバインド: 再試行ボタン
  document.getElementById("retry-sync-btn")?.addEventListener("click", () => {
    if (getPendingCount() > 0) {
      flushSave();
    } else {
      syncFromRemote();
    }
  });

  // イベントバインド: タスク追加フォーム
  document.getElementById("add-todo-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const titleInput = document.getElementById("new-title");
    const todayInput = document.getElementById("new-today");
    const dueInput = document.getElementById("new-due");
    const tagsInput = document.getElementById("new-tags");

    const title = titleInput.value.trim();
    if (!title) return;

    const newTodo = {
      id: crypto.randomUUID(),
      title,
      done: false,
      today: todayInput.checked,
      due: dueInput.value || null,
      tags: parseTagsInput(tagsInput.value),
      updatedAt: new Date().toISOString(),
    };

    titleInput.value = "";
    todayInput.checked = false;
    dueInput.value = "";
    tagsInput.value = "";

    upsertTodo(newTodo);
  });

  // イベントバインド: 完了済みをすべて消去
  document
    .getElementById("clear-completed-btn")
    ?.addEventListener("click", () => {
      clearCompletedTodos();
    });

  // 起動時は cache を即表示
  render();

  // 初回設定チェック
  if (!isConfigValid(settings)) {
    openSettingsModal();
  } else {
    // 裏で最新を取得し、未送信 pending が残っていれば再送
    syncFromRemote().then(() => {
      if (getPendingCount() > 0) {
        flushSave();
      }
    });
  }

  // オンライン復帰時に pending があれば再送
  window.addEventListener("online", () => {
    if (getPendingCount() > 0) {
      flushSave();
    } else {
      syncFromRemote();
    }
  });

  if (isMonitorMode) {
    // モニターモード: 画面が見えている間だけ45秒ごとに取得 + Wake Lock
    requestMonitorWakeLock();

    monitorPollTimer = setInterval(() => {
      if (document.visibilityState === "visible" && isConfigValid(settings)) {
        syncFromRemote();
      }
    }, MONITOR_POLL_MS);

    monitorStaleTimer = setInterval(() => {
      renderMonitorStatus();
    }, 10 * 1000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        requestMonitorWakeLock();
        if (isConfigValid(settings)) {
          syncFromRemote();
        }
      } else {
        releaseMonitorWakeLock();
      }
    });
  } else {
    // 通常モード: フォーカス復帰時（visibilitychange / focus）に取得
    const handleFocusSync = () => {
      if (document.visibilityState !== "visible") return;
      if (!isConfigValid(settings)) return;
      const now = Date.now();
      if (now - lastFocusFetchAt < 1000) return;
      lastFocusFetchAt = now;
      // 前面に戻ったとき、未送信の変更があれば再送する
      syncFromRemote().then(() => {
        if (getPendingCount() > 0 && !debounceTimer) flushSave();
      });
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        handleFocusSync();
      }
    });
    window.addEventListener("focus", handleFocusSync);
  }

  registerServiceWorker();
}

init();
