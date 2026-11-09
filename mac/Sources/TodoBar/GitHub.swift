import Foundation
import Security

struct GitHubConfig: Codable, Equatable {
    var owner = "krs893"
    var repo = "gh-todo-data"
    var path = "todos.json"
    var branch = "main"

    var isValid: Bool {
        !owner.trimmingCharacters(in: .whitespaces).isEmpty
            && !repo.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static let defaultsKey = "githubConfig"

    static func load() -> GitHubConfig {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let config = try? JSONDecoder().decode(GitHubConfig.self, from: data) else {
            return GitHubConfig()
        }
        return config
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}

enum GitHubError: Error {
    case http(Int, String)
    case invalidResponse
}

/// GitHub Contents API で todos.json を読み書きする
struct GitHubClient {
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        // キャッシュで古い sha を掴むと保存が 409 になり続けるため、毎回取りに行く
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    private func contentsURL(_ config: GitHubConfig, includeRef: Bool) -> URL? {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let enc = { (s: String) in
            s.trimmingCharacters(in: .whitespaces).addingPercentEncoding(withAllowedCharacters: allowed) ?? s
        }
        let path = config.path.split(separator: "/").map { enc(String($0)) }.joined(separator: "/")
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.github.com"
        components.percentEncodedPath = "/repos/\(enc(config.owner))/\(enc(config.repo))/contents/\(path)"
        if includeRef {
            components.queryItems = [URLQueryItem(name: "ref", value: config.branch)]
        }
        return components.url
    }

    private func request(_ url: URL, token: String, method: String) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        return req
    }

    private func check(_ response: URLResponse, _ data: Data) throws -> Int {
        guard let http = response as? HTTPURLResponse else { throw GitHubError.invalidResponse }
        if !(200..<300).contains(http.statusCode) && http.statusCode != 404 {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw GitHubError.http(http.statusCode, message ?? "")
        }
        return http.statusCode
    }

    /// ファイルがまだ無い（404）ときは空として返す
    func fetch(_ config: GitHubConfig, token: String) async throws -> (todos: [Todo], sha: String?) {
        guard let url = contentsURL(config, includeRef: true) else { throw GitHubError.invalidResponse }
        let (data, response) = try await session.data(for: request(url, token: token, method: "GET"))
        if try check(response, data) == 404 { return ([], nil) }

        struct Body: Decodable { let sha: String; let content: String }
        let body = try JSONDecoder().decode(Body.self, from: data)
        guard let raw = Data(base64Encoded: body.content, options: .ignoreUnknownCharacters) else {
            throw GitHubError.invalidResponse
        }
        return (try TodoJSON.decode(raw), body.sha)
    }

    /// 保存して新しい sha を返す。sha が古ければ 409（または 422）になる
    func put(_ config: GitHubConfig, token: String, todos: [Todo], sha: String?) async throws -> String {
        guard let url = contentsURL(config, includeRef: false) else { throw GitHubError.invalidResponse }
        var payload: [String: Any] = [
            "message": "Update todos",
            "content": Data(TodoJSON.encode(todos).utf8).base64EncodedString(),
            "branch": config.branch,
        ]
        if let sha { payload["sha"] = sha }
        var req = request(url, token: token, method: "PUT")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await session.data(for: req)
        if try check(response, data) == 404 {
            throw GitHubError.http(404, "Not Found")
        }

        struct Body: Decodable {
            struct Content: Decodable { let sha: String }
            let content: Content
        }
        return try JSONDecoder().decode(Body.self, from: data).content.sha
    }
}

/// トークンはこの Mac のキーチェーンに保存する
enum Keychain {
    private static let service = "io.github.krs893.todobar"
    private static let account = "github-token"

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func readToken() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func saveToken(_ token: String) {
        SecItemDelete(baseQuery as CFDictionary)
        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(query as CFDictionary, nil)
    }
}
