# CI/CD 与发布

本文档描述当前自动化发布链路：CI 检查与桌面端 macOS/Windows/Linux Release。

## 自动化入口

| 入口 | Workflow | 动作 |
|---|---|---|
| PR / `main` push | `.github/workflows/ci.yml` | 跑 GUI 前端与 Tauri Rust 测试。 |
| `v*` tag / 手动指定 tag | `.github/workflows/desktop-release.yml` | 并行构建 macOS Intel、macOS Apple Silicon、Windows x64 和 Linux x64 桌面包，并上传到 GitHub Release。 |

## GitHub Secrets

macOS signed/notarized release 需要这些 secrets：

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Developer ID Application `.p12` 的 base64。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)`。 |
| `APPLE_ID` | Apple Developer 账号邮箱。 |
| `APPLE_TEAM_ID` | `UU94JSVAA9`。 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password。 |

脚本化写入 GitHub 配置：

```bash
BOOTSTRAP_APPLE_SECRETS=1 \
APPLE_CERTIFICATE_PASSWORD=<p12-export-password> \
  scripts/release/bootstrap-github-secrets.sh
```

如果 `CERT_DIR/developer_id_application.p12` 不存在，脚本会从本机 Keychain 中的 `Developer ID Application: wenlin fei (UU94JSVAA9)` 自动导出，并生成 `.p12` 密码写入 GitHub Secret。`CERT_DIR` 默认优先使用 `~/Personal/cert`，不存在时使用 `~/Downloads/cert`。已有 `.p12` 时需要传入 `APPLE_CERTIFICATE_PASSWORD=<p12-password>`。

如果自动导出失败，先确认本机能看到可签名 identity：

```bash
security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
```

Keychain 中必须是带私钥的 `Developer ID Application` identity。若 macOS 拒绝私钥导出，可以在 Keychain Access 中手动导出 `.p12` 到 `P12_PATH`，再用同一个 `APPLE_CERTIFICATE_PASSWORD` 重新运行脚本。

脚本默认读取：

| 文件 | 用途 |
|---|---|
| `CERT_DIR/developer_id_application.p12` | CI 导入的签名 identity。 |
| `CERT_DIR/app key.md` | Apple app-specific password。 |

## 桌面产物

`desktop-release.yml` 产物：

| 平台 | Runner | 产物 |
|---|---|---|
| macOS Intel | `macos-15-intel` | `LiveAgent-vX.Y.Z-macOS-x64.dmg`。 |
| macOS Apple Silicon | `macos-14` | `LiveAgent-vX.Y.Z-macOS-aarch64.dmg`。 |
| Windows x64 | `windows-latest` | `LiveAgent-vX.Y.Z-Windows-x64.msi`、`LiveAgent-vX.Y.Z-Windows-x64-Setup.exe`、`LiveAgent-vX.Y.Z-Windows-x64-portable.zip`。 |
| Linux x64 | `ubuntu-latest` | `LiveAgent-vX.Y.Z-Linux-x86_64.AppImage`、`.deb`、`.rpm`。 |

发布 job 会上传各平台构建 job 汇总的安装包和便携包；桌面端「设置 -> 关于」不访问远程 Release，也不会自动安装新版本。

## 桌面版本号来源

本地开发和普通本机构建只维护一个默认版本源：`crates/agent-gui/package.json`。Tauri 默认配置、前端 About 页和 Rust 运行时代码都会从这里读取版本，因此日常开发不需要到多个文件里同步版本号。

正式发布时不依赖人工修改 `package.json`。`desktop-release.yml` 会先在 `Release Metadata` job 中解析 release tag：

```bash
node scripts/release/prepare-app-version-from-tag.mjs vX.Y.Z
```

这个脚本会校验 tag 必须是 `v` 开头的 semver，输出：

| 输出 | 示例 | 用途 |
|---|---|---|
| `LIVEAGENT_RELEASE_TAG` | `v0.1.3` | GitHub Release、产物命名和下载 URL。 |
| `LIVEAGENT_APP_VERSION` | `0.1.3` | 前端 About 页和 Rust 运行时代码。 |
| `LIVEAGENT_IS_PRERELEASE` | `false` | 决定 GitHub Release 是否标记为 prerelease。 |
| `LIVEAGENT_TAURI_VERSION_CONFIG` | `src-tauri/tauri.version.generated.conf.json` | Tauri 构建时追加的临时 config overlay。 |

各平台构建 job 会复用同一份 metadata，并生成一个未提交到仓库的 Tauri overlay：

```json
{
  "version": "0.1.3"
}
```

Tauri 构建命令通过额外的 `--config "$LIVEAGENT_TAURI_VERSION_CONFIG"` 注入这个版本；Vite 和 Rust build script 通过 `LIVEAGENT_APP_VERSION` 注入同一个版本。这样发布版本以 tag 为事实来源，应用内显示版本和安装包版本会保持一致；忘记改 `package.json` 不会导致发布包仍显示旧版本。

Windows 当前没有代码签名 secret，release workflow 会先自动发布 unsigned 包。接入 Windows `.p12/.pfx` 或 Trusted Signing 后再补签名步骤。
