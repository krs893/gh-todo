import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPending,
  buildClearCompletedPending,
  decodeBase64Utf8,
  encodeBase64Utf8,
  formatDueLabel,
  formatLocalDate,
  isOverdue,
  isToday,
  parseTagsInput,
  parseTodosJson,
  pruneResolvedPending,
  serializeTodosJson,
  sortTodos,
} from "../docs/sync.js";

describe("applyPending（統合ルール）", () => {
  it("base に無い id の upsert を追加できる", () => {
    const base = [
      {
        id: "t1",
        title: "既存タスク",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T09:00:00.000Z",
      },
    ];
    const pending = {
      t2: {
        type: "upsert",
        todo: {
          id: "t2",
          title: "新規タスク",
          done: false,
          today: true,
          due: "2026-11-12",
          tags: ["大学"],
          updatedAt: "2026-11-09T10:00:00.000Z",
        },
      },
    };

    const result = applyPending(base, pending);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "t1");
    assert.equal(result[1].id, "t2");
    assert.equal(result[1].title, "新規タスク");
  });

  it("同じ id の upsert は pending 側の updatedAt が新しい（または同じ）とき pending で置き換える", () => {
    const base = [
      {
        id: "t1",
        title: "古いタイトル",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T09:00:00.000Z",
      },
    ];
    const pending = {
      t1: {
        type: "upsert",
        todo: {
          id: "t1",
          title: "更新後のタイトル",
          done: true,
          today: true,
          due: "2026-11-10",
          tags: ["仕事"],
          updatedAt: "2026-11-09T10:00:00.000Z",
        },
      },
    };

    const result = applyPending(base, pending);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "更新後のタイトル");
    assert.equal(result[0].done, true);
  });

  it("base側.updatedAt > pending側.updatedAt のときだけ base を残す", () => {
    const base = [
      {
        id: "t1",
        title: "別端末でより新しく更新されたタイトル",
        done: false,
        today: true,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T11:00:00.000Z",
      },
      {
        id: "t2",
        title: "同時刻のタイトル(base)",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
    ];
    const pending = {
      t1: {
        type: "upsert",
        todo: {
          id: "t1",
          title: "手元の古い変更",
          done: false,
          today: false,
          due: null,
          tags: [],
          updatedAt: "2026-11-09T10:30:00.000Z",
        },
      },
      t2: {
        type: "upsert",
        todo: {
          id: "t2",
          title: "同時刻のタイトル(pending)",
          done: true,
          today: false,
          due: null,
          tags: [],
          updatedAt: "2026-11-09T10:00:00.000Z",
        },
      },
    };

    const result = applyPending(base, pending);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "別端末でより新しく更新されたタイトル");
    assert.equal(result[1].title, "同時刻のタイトル(pending)");
  });

  it("delete は base から同じ id を取り除き、base に無い id の delete は何もしない", () => {
    const base = [
      {
        id: "t1",
        title: "残るタスク",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T09:00:00.000Z",
      },
      {
        id: "t2",
        title: "消すタスク",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T09:00:00.000Z",
      },
    ];
    const pending = {
      t2: { type: "delete" },
      t999: { type: "delete" },
    };

    const result = applyPending(base, pending);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "t1");
  });

  it("別端末で削除済みのタスク（新しい base に無く pending にも無いもの）を復活させない", () => {
    // 以前ローカルキャッシュに t1, t2, t3 があったが、別端末で t2 が削除され、
    // 最新の GitHub (base) は t1, t3 のみになった状況を想定。
    // 手元では t1 だけ編集して pending に入っている。
    const latestRemoteBase = [
      {
        id: "t1",
        title: "タスク1",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T08:00:00.000Z",
      },
      {
        id: "t3",
        title: "タスク3",
        done: false,
        today: false,
        due: null,
        tags: [],
        updatedAt: "2026-11-09T08:00:00.000Z",
      },
    ];
    const pending = {
      t1: {
        type: "upsert",
        todo: {
          id: "t1",
          title: "タスク1（手元で更新）",
          done: false,
          today: true,
          due: null,
          tags: [],
          updatedAt: "2026-11-09T10:00:00.000Z",
        },
      },
    };

    const merged = applyPending(latestRemoteBase, pending);
    assert.deepEqual(
      merged.map((t) => t.id),
      ["t1", "t3"]
    );
    assert.equal(merged[0].title, "タスク1（手元で更新）");
  });

  it("完了済みをすべて消去すると完了済み各項目の delete が pending に積まれる", () => {
    const todos = [
      { id: "a", title: "未完了", done: false },
      { id: "b", title: "完了1", done: true },
      { id: "c", title: "完了2", done: true },
    ];
    const nextPending = buildClearCompletedPending(todos, {});
    assert.deepEqual(nextPending, {
      b: { type: "delete" },
      c: { type: "delete" },
    });
    const afterApply = applyPending(todos, nextPending);
    assert.deepEqual(
      afterApply.map((t) => t.id),
      ["a"]
    );
  });

  it("pruneResolvedPending は送信時点から変わっていない pending だけ消し、送信中に更新されたものを残す", () => {
    const sentPending = {
      t1: {
        type: "upsert",
        todo: { id: "t1", title: "A", updatedAt: "2026-11-09T10:00:00.000Z" },
      },
      t2: {
        type: "upsert",
        todo: { id: "t2", title: "B", updatedAt: "2026-11-09T10:00:00.000Z" },
      },
      t3: { type: "delete" },
    };
    const currentPending = {
      t1: {
        type: "upsert",
        todo: { id: "t1", title: "A", updatedAt: "2026-11-09T10:00:00.000Z" },
      },
      t2: {
        type: "upsert",
        todo: {
          id: "t2",
          title: "B（保存中に再編集）",
          updatedAt: "2026-11-09T10:01:00.000Z",
        },
      },
      t3: { type: "delete" },
      t4: {
        type: "upsert",
        todo: { id: "t4", title: "保存中に新規追加", updatedAt: "2026-11-09T10:02:00.000Z" },
      },
    };

    const remaining = pruneResolvedPending(currentPending, sentPending);
    assert.deepEqual(Object.keys(remaining), ["t2", "t4"]);
    assert.equal(remaining.t2.todo.title, "B（保存中に再編集）");
  });
});

describe("sortTodos（並び替え規則）", () => {
  const todayStr = "2026-11-09";

  it("1.期限切れ → 2.今日 → 3.今後 → 4.期限なし のグループ順に並ぶ", () => {
    const items = [
      {
        id: "no-due",
        title: "期限なし",
        done: false,
        today: false,
        due: null,
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "upcoming",
        title: "今後",
        done: false,
        today: false,
        due: "2026-11-12",
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "today-flag",
        title: "今日やるフラグ",
        done: false,
        today: true,
        due: null,
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "overdue",
        title: "期限切れ",
        done: false,
        today: false,
        due: "2026-11-08",
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
    ];

    const sorted = sortTodos(items, todayStr);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ["overdue", "today-flag", "upcoming", "no-due"]
    );
  });

  it("同じグループ内は today: true が先、次に due 昇順、次に updatedAt 降順になる", () => {
    const items = [
      // グループ1（期限切れ）内での比較
      {
        id: "overdue-later",
        title: "期限切れ(11/08, today=false)",
        done: false,
        today: false,
        due: "2026-11-08",
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "overdue-earlier",
        title: "期限切れ(11/05, today=false)",
        done: false,
        today: false,
        due: "2026-11-05",
        updatedAt: "2026-11-09T08:00:00.000Z",
      },
      {
        id: "overdue-today-flag",
        title: "期限切れ(11/08, today=true)",
        done: false,
        today: true,
        due: "2026-11-08",
        updatedAt: "2026-11-09T07:00:00.000Z",
      },
      // グループ2（今日）内での比較
      {
        id: "today-due-only-old",
        title: "今日期限のみ(古)",
        done: false,
        today: false,
        due: "2026-11-09",
        updatedAt: "2026-11-09T08:00:00.000Z",
      },
      {
        id: "today-due-only-new",
        title: "今日期限のみ(新)",
        done: false,
        today: false,
        due: "2026-11-09",
        updatedAt: "2026-11-09T09:30:00.000Z",
      },
      {
        id: "today-flag-no-due",
        title: "今日やる(期限なし)",
        done: false,
        today: true,
        due: null,
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "today-flag-with-due",
        title: "今日やる(今日期限)",
        done: false,
        today: true,
        due: "2026-11-09",
        updatedAt: "2026-11-09T07:00:00.000Z",
      },
      // グループ3（今後）内での比較
      {
        id: "upcoming-11-15",
        title: "今後 11/15",
        done: false,
        today: false,
        due: "2026-11-15",
        updatedAt: "2026-11-09T10:00:00.000Z",
      },
      {
        id: "upcoming-11-10-old",
        title: "今後 11/10(古)",
        done: false,
        today: false,
        due: "2026-11-10",
        updatedAt: "2026-11-09T08:00:00.000Z",
      },
      {
        id: "upcoming-11-10-new",
        title: "今後 11/10(新)",
        done: false,
        today: false,
        due: "2026-11-10",
        updatedAt: "2026-11-09T09:00:00.000Z",
      },
    ];

    const sorted = sortTodos(items, todayStr);
    assert.deepEqual(
      sorted.map((t) => t.id),
      [
        // 1. 期限切れ: today=true -> due昇順
        "overdue-today-flag",
        "overdue-earlier",
        "overdue-later",
        // 2. 今日: today=true (dueあり -> dueなし) -> today=false (updatedAt降順)
        "today-flag-with-due",
        "today-flag-no-due",
        "today-due-only-new",
        "today-due-only-old",
        // 3. 今後: due昇順 -> updatedAt降順
        "upcoming-11-10-new",
        "upcoming-11-10-old",
        "upcoming-11-15",
      ]
    );
  });
});

describe("UTF-8 Base64 往復と JSON 整形", () => {
  it("日本語・絵文字を含む文字列を UTF-8 Base64 で往復変換できる", () => {
    const original = "レポートを進める 📝🚀 大学・研究室👨‍👩‍👧‍👦";
    const encoded = encodeBase64Utf8(original);
    const decoded = decodeBase64Utf8(encoded);
    assert.equal(decoded, original);
  });

  it("GitHub Contents API のように改行が入った Base64 も正しくデコードできる", () => {
    const todos = [
      {
        id: "uuid-1",
        title: "日本語のタスク名と絵文字 🎉",
        done: false,
        today: true,
        due: "2026-11-12",
        tags: ["大学", "ゼミ"],
        updatedAt: "2026-11-09T10:40:00.000Z",
      },
    ];
    const jsonText = serializeTodosJson(todos);
    assert.ok(jsonText.endsWith("\n"), "末尾に改行があること");

    const b64 = encodeBase64Utf8(jsonText);
    // 20文字ごとに改行を挿入して GitHub API のレスポンス形式を模倣
    const withNewlines = b64.replace(/(.{20})/g, "$1\n");
    const decodedJson = decodeBase64Utf8(withNewlines);
    assert.equal(decodedJson, jsonText);

    const parsedTodos = parseTodosJson(decodedJson);
    assert.deepEqual(parsedTodos, todos);
  });
});

describe("ローカル日付の今日判定・期限ラベル", () => {
  it("formatLocalDate はローカルの年・月・日から YYYY-MM-DD を返す", () => {
    // ローカル時間で 2026年11月9日 01:05（JSTならUTCでは前日16:05になる時刻）
    const localMorning = new Date(2026, 10, 9, 1, 5, 0);
    assert.equal(formatLocalDate(localMorning), "2026-11-09");
  });

  it("isToday と isOverdue がローカル日付文字列で正しく判定する", () => {
    const today = "2026-11-09";
    assert.equal(isToday("2026-11-09", today), true);
    assert.equal(isToday("2026-11-10", today), false);
    assert.equal(isToday(null, today), false);

    assert.equal(isOverdue("2026-11-08", today), true);
    assert.equal(isOverdue("2026-11-09", today), false);
    assert.equal(isOverdue("2026-11-10", today), false);
    assert.equal(isOverdue(null, today), false);
  });

  it("formatDueLabel は「今日」「明日」「M/D(曜)」を返す", () => {
    const today = "2026-11-09"; // 2026-11-09 は月曜日
    assert.equal(formatDueLabel("2026-11-09", today), "今日");
    assert.equal(formatDueLabel("2026-11-10", today), "明日");
    assert.equal(formatDueLabel("2026-11-11", today), "11/11(水)");
    assert.equal(formatDueLabel("2026-11-12", today), "11/12(木)");
    assert.equal(formatDueLabel(null, today), "");
  });

  it("parseTagsInput はカンマや読点で分割し空白除去・重複排除する", () => {
    assert.deepEqual(parseTagsInput(" 大学, 課題、 大学 , "), ["大学", "課題"]);
  });
});
