import AppKit
import ServiceManagement
import SwiftUI

private let webAppURL = URL(string: "https://krs893.github.io/gh-todo/")!

@main
struct TodoBarApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            ContentView()
                .environmentObject(store)
        } label: {
            // 期限切れ・今日のタスクがあれば件数を出す
            if store.focusCount > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "checklist")
                    Text("\(store.focusCount)")
                }
            } else {
                Image(systemName: "checklist")
            }
        }
        .menuBarExtraStyle(.window)
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: Store
    @State private var showingSettings = false

    var body: some View {
        Group {
            if showingSettings || !store.isConfigured {
                SettingsView(onClose: { showingSettings = false })
            } else {
                MainView(showSettings: { showingSettings = true })
            }
        }
        .frame(width: 320)
    }
}

struct MainView: View {
    @EnvironmentObject private var store: Store
    let showSettings: () -> Void
    @State private var newTitle = ""
    @FocusState private var inputFocused: Bool

    private let rowHeight: CGFloat = 32

    var body: some View {
        let todos = store.visibleTodos
        VStack(spacing: 0) {
            TextField("タスクを追加", text: $newTitle)
                .textFieldStyle(.roundedBorder)
                .focused($inputFocused)
                .onSubmit {
                    store.add(newTitle)
                    newTitle = ""
                }
                .padding(12)

            Divider()

            if todos.isEmpty {
                Text("やることはありません")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(todos) { todo in
                            TodoRow(todo: todo, height: rowHeight)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .frame(height: min(CGFloat(todos.count) * rowHeight + 8, 400))
            }

            Divider()

            HStack {
                Text(store.statusText)
                    .font(.caption)
                    .foregroundStyle(store.errorMessage == nil ? Color.secondary : Color.red)
                    .lineLimit(1)
                Spacer()
                Menu {
                    Button("今すぐ同期") { Task { await store.syncNow() } }
                    Button("Web 版を開く") { NSWorkspace.shared.open(webAppURL) }
                    Divider()
                    Toggle("ログイン時に起動", isOn: Binding(
                        get: { SMAppService.mainApp.status == .enabled },
                        set: { enabled in
                            if enabled {
                                try? SMAppService.mainApp.register()
                            } else {
                                try? SMAppService.mainApp.unregister()
                            }
                        }
                    ))
                    Button("設定…", action: showSettings)
                    Divider()
                    Button("終了") { NSApp.terminate(nil) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .onAppear { inputFocused = true }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            inputFocused = true
            store.refreshIfStale()
        }
    }
}

struct TodoRow: View {
    @EnvironmentObject private var store: Store
    let todo: Todo
    let height: CGFloat
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Button {
                store.complete(todo)
            } label: {
                Image(systemName: hovering ? "checkmark.circle" : "circle")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("完了にする")

            Text(todo.title)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(todo.title)

            Spacer(minLength: 4)

            if hovering {
                Button {
                    store.delete(todo)
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("削除")
            } else if let label = TodoLogic.dueLabel(todo) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(TodoLogic.isOverdue(todo) ? Color.red : Color.secondary)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: height)
        .background(hovering ? Color.primary.opacity(0.06) : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            Button("完了にする") { store.complete(todo) }
            Button("削除") { store.delete(todo) }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: Store
    let onClose: () -> Void
    @State private var owner = ""
    @State private var repo = ""
    @State private var path = ""
    @State private var branch = ""
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("GitHub 同期設定").font(.headline)
            labeled("ユーザー名", TextField("krs893", text: $owner))
            labeled("データ用リポジトリ", TextField("gh-todo-data", text: $repo))
            HStack {
                labeled("ファイル", TextField("todos.json", text: $path))
                labeled("ブランチ", TextField("main", text: $branch))
            }
            labeled("トークン", SecureField(store.hasToken ? "保存済み（変えるときだけ入力）" : "github_pat_…", text: $token))
            Text("Contents: Read and write の権限が必要です。トークンはこの Mac のキーチェーンに保存されます。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                if store.isConfigured {
                    Button("キャンセル", action: onClose)
                } else {
                    Button("終了") { NSApp.terminate(nil) }
                }
                Spacer()
                Button("保存") {
                    var config = GitHubConfig()
                    config.owner = owner.trimmingCharacters(in: .whitespaces)
                    config.repo = repo.trimmingCharacters(in: .whitespaces)
                    config.path = path.trimmingCharacters(in: .whitespaces).isEmpty ? "todos.json" : path
                    config.branch = branch.trimmingCharacters(in: .whitespaces).isEmpty ? "main" : branch
                    store.updateSettings(config, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
                    token = ""
                    onClose()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(owner.isEmpty || repo.isEmpty || (!store.hasToken && token.isEmpty))
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(14)
        .onAppear {
            owner = store.config.owner
            repo = store.config.repo
            path = store.config.path
            branch = store.config.branch
        }
    }

    private func labeled(_ title: String, _ field: some View) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            field
        }
    }
}
