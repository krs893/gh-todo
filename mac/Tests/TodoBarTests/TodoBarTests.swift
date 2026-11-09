import XCTest
@testable import TodoBar

final class TodoBarTests: XCTestCase {
    private func todo(_ id: String, done: Bool = false, today: Bool = false, due: String? = nil,
                      tags: [String] = [], updatedAt: String = "2026-11-01T00:00:00.000Z",
                      deletedAt: String? = nil) -> Todo {
        Todo(id: id, title: id, done: done, today: today, due: due, tags: tags,
             updatedAt: updatedAt, deletedAt: deletedAt)
    }

    /// Web 版の JSON.stringify(data, null, 2) + "\n" と同じ書式になること
    func testEncodeMatchesWebFormat() {
        let todos = [
            Todo(id: "a", title: "レポート \"下書き\" a/b", done: false, today: true, due: "2026-11-12",
                 tags: ["大学", "課題"], updatedAt: "2026-11-09T02:14:58.242Z"),
            Todo(id: "b", title: "牛乳", done: true, today: false, due: nil, tags: [],
                 updatedAt: "2026-11-09T03:00:00.000Z", deletedAt: "2026-11-09T03:00:00.000Z"),
        ]
        let expected = """
        {
          "todos": [
            {
              "id": "a",
              "title": "レポート \\"下書き\\" a/b",
              "done": false,
              "today": true,
              "due": "2026-11-12",
              "tags": [
                "大学",
                "課題"
              ],
              "updatedAt": "2026-11-09T02:14:58.242Z"
            },
            {
              "id": "b",
              "title": "牛乳",
              "done": true,
              "today": false,
              "due": null,
              "tags": [],
              "deletedAt": "2026-11-09T03:00:00.000Z",
              "updatedAt": "2026-11-09T03:00:00.000Z"
            }
          ]
        }

        """
        XCTAssertEqual(TodoJSON.encode(todos), expected)
        XCTAssertEqual(TodoJSON.encode([]), "{\n  \"todos\": []\n}\n")
        XCTAssertEqual(try TodoJSON.decode(Data(expected.utf8)), todos)
    }

    func testDecodeToleratesMissingFields() throws {
        let todos = try TodoJSON.decode(Data(#"{"todos":[{"id":"x","title":"t"}]}"#.utf8))
        XCTAssertEqual(todos, [Todo(id: "x", title: "t", updatedAt: "")])
    }

    func testApplyPending() {
        let base = [todo("a"), todo("b", updatedAt: "2026-11-09T10:00:00.000Z")]
        let pending = [
            "a": todo("a", done: true, updatedAt: "2026-11-09T00:00:00.000Z"),
            "b": todo("b", done: true, updatedAt: "2026-11-09T09:00:00.000Z"), // GitHub 側が新しい
            "c": todo("c", updatedAt: "2026-11-09T00:00:00.000Z"),
        ]
        let result = TodoLogic.applyPending(base, pending)
        XCTAssertEqual(result.map(\.id), ["a", "b", "c"])
        XCTAssertTrue(result[0].done)
        XCTAssertFalse(result[1].done)
        // 別の端末で消された（base に無く pending にも無い）ものは復活しない
        XCTAssertEqual(TodoLogic.applyPending([todo("a")], [:]).map(\.id), ["a"])
    }

    func testVisibleExcludesDoneAndDeleted() {
        let todos = [todo("a"), todo("b", done: true), todo("c", deletedAt: "2026-11-09T00:00:00.000Z")]
        XCTAssertEqual(todos.filter(\.isActive).map(\.id), ["a"])
    }

    func testSortOrder() {
        let today = "2026-11-09"
        let todos = [
            todo("none"),
            todo("later", due: "2026-11-20"),
            todo("soon", due: "2026-11-12"),
            todo("todayFlag", today: true),
            todo("dueToday", due: "2026-11-09"),
            todo("overdue", due: "2026-11-01"),
        ]
        XCTAssertEqual(TodoLogic.sorted(todos, today: today).map(\.id),
                       ["overdue", "todayFlag", "dueToday", "soon", "later", "none"])
    }

    func testDueLabel() {
        let today = "2026-11-09"
        XCTAssertEqual(TodoLogic.dueLabel(todo("a", due: "2026-11-09"), today: today), "今日")
        XCTAssertEqual(TodoLogic.dueLabel(todo("a", due: "2026-11-10"), today: today), "明日")
        XCTAssertEqual(TodoLogic.dueLabel(todo("a", due: "2026-11-12"), today: today), "11/12(木)")
        XCTAssertEqual(TodoLogic.dueLabel(todo("a", due: "2026-11-08"), today: today), "期限切れ 11/8(日)")
        XCTAssertEqual(TodoLogic.dueLabel(todo("a", due: "2027-01-05"), today: today), "2027/1/5(火)")
        XCTAssertNil(TodoLogic.dueLabel(todo("a"), today: today))
    }
}
