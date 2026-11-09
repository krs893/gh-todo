import Foundation

/// todos.json の1件。Web 版（docs/sync.js）と同じ形式。
struct Todo: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var done: Bool
    var today: Bool
    var due: String?
    var tags: [String]
    var updatedAt: String
    /// 削除した日時。削除しても todos.json からは消さず、画面に出さないだけ
    var deletedAt: String?

    /// 画面に出すタスクかどうか（未完了かつ削除されていない）
    var isActive: Bool { !done && deletedAt == nil }

    init(id: String, title: String, done: Bool = false, today: Bool = false,
         due: String? = nil, tags: [String] = [], updatedAt: String, deletedAt: String? = nil) {
        self.id = id
        self.title = title
        self.done = done
        self.today = today
        self.due = due
        self.tags = tags
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }

    // 欠けている項目があっても読めるようにする
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        today = try c.decodeIfPresent(Bool.self, forKey: .today) ?? false
        due = try c.decodeIfPresent(String.self, forKey: .due)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
    }
}

enum Clock {
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// JavaScript の toISOString() と同じ形式（例: 2026-11-09T02:14:58.242Z）
    static func nowISO() -> String { isoFormatter.string(from: Date()) }

    /// 端末のローカル日付（YYYY-MM-DD）
    static func localDateString(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func parseLocalDate(_ s: String) -> Date? {
        let parts = s.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

/// 並び順・統合ルール。Web 版の sync.js と同じ規則。
enum TodoLogic {
    /// GitHub の内容（base）の上に、手元でまだ送っていない変更だけを重ねる
    static func applyPending(_ base: [Todo], _ pending: [String: Todo]) -> [Todo] {
        var seen = Set<String>()
        var result: [Todo] = []
        for todo in base {
            seen.insert(todo.id)
            if let local = pending[todo.id] {
                result.append(todo.updatedAt > local.updatedAt ? todo : local)
            } else {
                result.append(todo)
            }
        }
        let added = pending.values
            .filter { !seen.contains($0.id) }
            .sorted { $0.updatedAt < $1.updatedAt }
        result.append(contentsOf: added)
        return result
    }

    /// 1: 期限切れ 2: 今日（今日やる・今日が期限） 3: 今後 4: 期限なし
    static func group(_ todo: Todo, today: String) -> Int {
        if let due = todo.due, due < today { return 1 }
        if todo.today || todo.due == today { return 2 }
        if todo.due != nil { return 3 }
        return 4
    }

    static func sorted(_ todos: [Todo], today: String = Clock.localDateString()) -> [Todo] {
        todos.sorted { a, b in
            let ga = group(a, today: today), gb = group(b, today: today)
            if ga != gb { return ga < gb }
            if a.today != b.today { return a.today }
            if a.due != b.due {
                guard let da = a.due else { return false }
                guard let db = b.due else { return true }
                return da < db
            }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return a.id < b.id
        }
    }

    static func isOverdue(_ todo: Todo, today: String = Clock.localDateString()) -> Bool {
        guard let due = todo.due else { return false }
        return due < today
    }

    /// 「今日」「明日」「11/12(水)」「期限切れ 11/8」
    static func dueLabel(_ todo: Todo, today: String = Clock.localDateString()) -> String? {
        guard let due = todo.due, let dueDate = Clock.parseLocalDate(due) else { return nil }
        if due == today { return "今日" }
        if let todayDate = Clock.parseLocalDate(today),
           let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: todayDate),
           Clock.localDateString(tomorrow) == due {
            return "明日"
        }
        let c = Calendar.current.dateComponents([.year, .month, .day, .weekday], from: dueDate)
        let weekdays = ["日", "月", "火", "水", "木", "金", "土"]
        let weekday = weekdays[((c.weekday ?? 1) - 1) % 7]
        let todayYear = Clock.parseLocalDate(today).map { Calendar.current.component(.year, from: $0) }
        let date = c.year == todayYear
            ? "\(c.month ?? 0)/\(c.day ?? 0)(\(weekday))"
            : "\(c.year ?? 0)/\(c.month ?? 0)/\(c.day ?? 0)(\(weekday))"
        return due < today ? "期限切れ \(date)" : date
    }
}

/// todos.json の読み書き。Web 版の JSON.stringify(data, null, 2) と同じ書式で書き、
/// どの端末から保存しても GitHub 上の差分が増えないようにする。
enum TodoJSON {
    private struct File: Decodable { let todos: [Todo]? }

    static func decode(_ data: Data) throws -> [Todo] {
        if data.isEmpty { return [] }
        return try JSONDecoder().decode(File.self, from: data).todos ?? []
    }

    static func encode(_ todos: [Todo]) -> String {
        if todos.isEmpty { return "{\n  \"todos\": []\n}\n" }
        var lines = ["{", "  \"todos\": ["]
        for (index, todo) in todos.enumerated() {
            var fields = [
                "\"id\": \(string(todo.id))",
                "\"title\": \(string(todo.title))",
                "\"done\": \(todo.done)",
                "\"today\": \(todo.today)",
                "\"due\": \(todo.due.map(string) ?? "null")",
            ]
            if todo.tags.isEmpty {
                fields.append("\"tags\": []")
            } else {
                let items = todo.tags.map { "        " + string($0) }.joined(separator: ",\n")
                fields.append("\"tags\": [\n\(items)\n      ]")
            }
            if let deletedAt = todo.deletedAt {
                fields.append("\"deletedAt\": \(string(deletedAt))")
            }
            fields.append("\"updatedAt\": \(string(todo.updatedAt))")
            lines.append("    {")
            lines.append(fields.map { "      " + $0 }.joined(separator: ",\n"))
            lines.append(index < todos.count - 1 ? "    }," : "    }")
        }
        lines.append("  ]")
        lines.append("}")
        return lines.joined(separator: "\n") + "\n"
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    private static func string(_ value: String) -> String {
        guard let data = try? encoder.encode(value), let s = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return s
    }
}
