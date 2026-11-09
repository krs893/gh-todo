import AppKit
import Foundation

/// タスクの状態と GitHub との同期。保存の規則は Web 版（docs/app.js）と同じ:
/// - 変更は pending に積み、1.5秒まとめてから保存する（同時に1つだけ）
/// - 409/422 のときだけ最新を取り直し、まだ送っていない変更を重ねて再送する（最大3回）
@MainActor
final class Store: ObservableObject {
    @Published private(set) var cacheTodos: [Todo] = []
    @Published private(set) var pending: [String: Todo] = [:]
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var isSaving = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var config = GitHubConfig.load()
    @Published private(set) var hasToken = false

    private var token: String?
    private var sha: String?
    private var isFetching = false
    private var saveQueued = false
    private var debounceTask: Task<Void, Never>?
    private var cacheVersion = 0 // cache を書き換えるたびに増やし、古い取得結果で上書きしない
    private var lastRefreshAt = Date.distantPast
    private var timer: Timer?
    private let client = GitHubClient()

    var isConfigured: Bool { config.isValid && hasToken }

    var visibleTodos: [Todo] {
        TodoLogic.sorted(TodoLogic.applyPending(cacheTodos, pending).filter(\.isActive))
    }

    /// メニューバーに出す件数（期限切れ・今日）
    var focusCount: Int {
        let today = Clock.localDateString()
        return visibleTodos.filter { TodoLogic.group($0, today: today) <= 2 }.count
    }

    var statusText: String {
        if !isConfigured { return "未設定" }
        if isSaving { return "保存中…" }
        if let errorMessage {
            return pending.isEmpty ? errorMessage : "\(errorMessage)（未送信 \(pending.count)件）"
        }
        if !pending.isEmpty { return "未送信 \(pending.count)件" }
        guard let lastSyncedAt else { return "未同期" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return "同期済み \(f.string(from: lastSyncedAt))"
    }

    init() {
        token = TokenStore.read()
        hasToken = token?.isEmpty == false
        loadState()

        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.syncNow() }
        }
        Task { await syncNow() }
    }

    // MARK: - 操作

    func complete(_ todo: Todo) {
        var updated = todo
        updated.done = true
        setPending(updated)
    }

    /// 画面から消すだけで、todos.json には deletedAt を付けて残す
    func delete(_ todo: Todo) {
        var updated = todo
        updated.deletedAt = Clock.nowISO()
        setPending(updated)
    }

    func updateSettings(_ newConfig: GitHubConfig, token newToken: String?) {
        if newConfig != config {
            // 別のリポジトリを指したら、前の内容は使わない
            cacheVersion += 1
            cacheTodos = []
            sha = nil
            lastSyncedAt = nil
        }
        config = newConfig
        config.save()
        if let newToken, !newToken.isEmpty {
            TokenStore.save(newToken)
            token = newToken
            hasToken = true
        }
        errorMessage = nil
        saveState()
        Task { await syncNow() }
    }

    /// 開いたときに呼ぶ。直前に取得していれば何もしない
    func refreshIfStale() {
        guard Date().timeIntervalSince(lastRefreshAt) > 10 else { return }
        Task { await syncNow() }
    }

    func syncNow() async {
        await refresh()
        if !pending.isEmpty && debounceTask == nil {
            await flushSave()
        }
    }

    // MARK: - 同期

    func refresh() async {
        guard isConfigured, let token, !isFetching, !isSaving else { return }
        isFetching = true
        defer { isFetching = false }
        lastRefreshAt = Date()
        let versionAtStart = cacheVersion
        do {
            let remote = try await client.fetch(config, token: token)
            // 取得中に保存が終わっていたら、この結果は古いので捨てる
            guard versionAtStart == cacheVersion else { return }
            cacheVersion += 1
            cacheTodos = remote.todos
            sha = remote.sha
            lastSyncedAt = Date()
            if pending.isEmpty { errorMessage = nil }
            saveState()
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    private func setPending(_ todo: Todo) {
        var updated = todo
        updated.updatedAt = Clock.nowISO()
        pending[updated.id] = updated
        saveState()
        scheduleSave()
    }

    private func scheduleSave() {
        errorMessage = nil
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, let self else { return }
            self.debounceTask = nil
            await self.flushSave()
        }
    }

    private func flushSave() async {
        guard isConfigured, let token, !pending.isEmpty else { return }
        if isSaving {
            saveQueued = true
            return
        }
        isSaving = true
        saveQueued = false
        errorMessage = nil

        var retries = 0
        do {
            while true {
                let sent = pending
                if sent.isEmpty { break }
                let next = TodoLogic.applyPending(cacheTodos, sent)
                do {
                    let newSha = try await client.put(config, token: token, todos: next, sha: sha)
                    cacheVersion += 1
                    cacheTodos = next
                    sha = newSha
                    lastSyncedAt = Date()
                    // 送った後に変わっていないものだけ消す
                    for (id, todo) in sent where pending[id] == todo {
                        pending.removeValue(forKey: id)
                    }
                    saveState()
                    break
                } catch GitHubError.http(let code, _) where (code == 409 || code == 422) && retries < 3 {
                    retries += 1
                    let remote = try await client.fetch(config, token: token)
                    cacheVersion += 1
                    cacheTodos = remote.todos
                    sha = remote.sha
                    saveState()
                }
            }
        } catch {
            errorMessage = Self.describe(error)
        }
        isSaving = false

        if errorMessage == nil && (saveQueued || !pending.isEmpty) && debounceTask == nil {
            saveQueued = false
            await flushSave()
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case GitHubError.http(let code, _) where code == 401 || code == 403:
            return "トークンが無効か権限がありません"
        case GitHubError.http(404, _):
            return "リポジトリが見つかりません"
        case GitHubError.http(let code, _):
            return "GitHub エラー (\(code))"
        case is URLError:
            return "通信できません"
        default:
            return "同期エラー"
        }
    }

    // MARK: - 端末内の保存（最後に取得した内容と未送信の変更）

    private struct SavedState: Codable {
        var todos: [Todo]
        var sha: String?
        var lastSyncedAt: Date?
        var pending: [String: Todo]
    }

    private var stateURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TodoBar", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("state.json")
    }

    private func loadState() {
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(SavedState.self, from: data) else { return }
        cacheTodos = state.todos
        sha = state.sha
        lastSyncedAt = state.lastSyncedAt
        pending = state.pending
    }

    private func saveState() {
        let state = SavedState(todos: cacheTodos, sha: sha, lastSyncedAt: lastSyncedAt, pending: pending)
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: stateURL, options: .atomic)
        }
    }
}
