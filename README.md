# Yubikiri Proxy Pro

高速で安全なウェブプロキシサービス。CroxyProxy のようなシンプルで強力なプロキシツール。Puppeteerでフルブラウザレンダリング。

## 機能

- 🚀 Puppeteerベースのフルブラウザレンダリング
- 🔒 セキュアな通信（XSS対策）
- 🌐 JavaScriptサポート（ページ遷移対応）
- 🎨 プレミアムなグラデーションUI
- 📱 レスポンシブデザイン
- ✨ カーソル上でURL入力バー表示
- 📄 PDF生成機能
- 📸 スクリーンショット機能
- ⚡ Render対応（@sparticuz/chromium使用）

## セットアップ

### 要件

- Node.js 18.x以上
- npm または yarn

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/yubikiri-proxy-pro.git
cd yubikiri-proxy-pro

# 依存関係をインストール
npm install

# .env ファイルを作成
cp .env.example .env
```

### ローカル開発

```bash
# 開発サーバーを起動
npm run dev
```

ブラウザで `http://localhost:3000` にアクセス。

### 本番環境

```bash
# サーバーを起動
npm start
```

## Renderへのデプロイ

### 1. GitHubにプッシュ

```bash
# ローカルでリポジトリを初期化
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/yourusername/yubikiri-proxy-pro.git
git push -u origin main
```

### 2. Renderでデプロイ

1. [Render Dashboard](https://dashboard.render.com) にアクセス
2. 「New +」 → 「Web Service」を選択
3. GitHubリポジトリを接続
4. デプロイ設定:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. 「Create Web Service」をクリック

### 3. 環境変数の設定

Renderダッシュボードで以下を設定:

```
PORT=3000
NODE_ENV=production
```

## フォルダ構造

```
yubikiri-proxy-pro/
├── server.js              # メインサーバーファイル
├── public/
│   └── index.html        # フロントエンド
├── package.json          # 依存関係
├── .env.example          # 環境変数テンプレート
├── .gitignore            # Git除外設定
└── README.md             # このファイル
```

## APIエンドポイント

### POST /api/proxy

プロキシリクエストを処理します。

**リクエスト:**
```json
{
  "url": "https://example.com"
}
```

**レスポンス:**
```json
{
  "success": true,
  "content": "HTML content...",
  "headers": {...},
  "status": 200
}
```

## 開発ガイド

### package.json の説明

- `express`: Webサーバーフレームワーク
- `cors`: クロスオリジンリクエスト対応
- `axios`: HTTPクライアント
- `dotenv`: 環境変数管理

### 主要ファイルの説明

**server.js:**
- Express サーバーの設定
- /api/proxy エンドポイントの実装
- 静的ファイルの配信

**public/index.html:**
- UI/UX デザイン
- フロントエンドロジック
- プロキシ機能の実装

## トラブルシューティング

### ポート衝突エラー

```bash
# 別のポートを使用
PORT=5000 npm start
```

### CORS エラー

CORS設定は既に実装済みです。

### デプロイエラー

Render ダッシュボードのログを確認してください。

## セキュリティ注意事項

- このプロキシは教育目的で設計されています
- 本番環境では適切なセキュリティ対策を実装してください
- ユーザーのプライバシーを尊重してください

## ライセンス

MIT

## サポート

問題が発生した場合は、GitHubの Issues セクションで報告してください。

---

**作成日:** 2025年
**バージョン:** 1.0.0