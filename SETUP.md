# AIBO システム — セットアップ＆デプロイガイド

## 1. 必要なアカウント・ツール

| ツール | 用途 | URL |
|--------|------|-----|
| Google Cloud アカウント | Cloud Run / Firestore | cloud.google.com |
| LINE Developers アカウント | Messaging API | developers.line.biz |
| OpenAI アカウント | 物件情報AI解析 | platform.openai.com |
| Node.js 20以上 | ローカル開発 | nodejs.org |
| Google Cloud CLI | デプロイ | cloud.google.com/sdk |

---

## 2. LINE Messaging API の設定

### 2-1. チャネル作成
1. https://developers.line.biz にログイン
2. 「新規チャネル作成」→「Messaging API」を選択
3. チャネル名: **AIBO不動産**
4. チャネル作成後、以下をメモする：
   - **Channel Secret**（チャネル基本設定）
   - **Channel access token（長期）**（Messaging API設定）

### 2-2. Webhook設定（Cloud Runデプロイ後）
1. Messaging API設定 → Webhook設定
2. Webhook URL: `https://[Cloud Run URL]/webhook`
3. 「Webhookの利用」を ON
4. 「検証」ボタンで `{"result":"ok"}` が返れば成功

### 2-3. リッチメニュー設定
LINE Official Account Manager でリッチメニューを作成：
- 物件登録
- 希望案件
- 報酬確認
- 商流確認
- お問い合わせ
- Webで見る

---

## 3. Google Cloud の設定

```bash
# 1. プロジェクト作成
gcloud projects create aibo-system-prod
gcloud config set project aibo-system-prod

# 2. 必要なAPIを有効化
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com

# 3. Firestoreデータベース作成（asia-northeast1 = 東京）
gcloud firestore databases create --region=asia-northeast1
```

---

## 4. シークレット設定（環境変数）

```bash
# LINE Channel Secret
echo -n "your_channel_secret" | gcloud secrets create LINE_CHANNEL_SECRET \
  --data-file=- --replication-policy=automatic

# LINE Access Token
echo -n "your_access_token" | gcloud secrets create LINE_CHANNEL_ACCESS_TOKEN \
  --data-file=- --replication-policy=automatic

# OpenAI API Key
echo -n "sk-proj-xxx" | gcloud secrets create OPENAI_API_KEY \
  --data-file=- --replication-policy=automatic

# 管理者LINE User ID
echo -n "Uxxxxxxxxxx" | gcloud secrets create ADMIN_LINE_USER_ID \
  --data-file=- --replication-policy=automatic
```

---

## 5. Cloud Run デプロイ

```bash
# プロジェクトルートで実行
gcloud run deploy aibo-webhook \
  --source . \
  --region asia-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="LINE_CHANNEL_SECRET=LINE_CHANNEL_SECRET:latest,\
LINE_CHANNEL_ACCESS_TOKEN=LINE_CHANNEL_ACCESS_TOKEN:latest,\
OPENAI_API_KEY=OPENAI_API_KEY:latest,\
ADMIN_LINE_USER_ID=ADMIN_LINE_USER_ID:latest"
```

デプロイ完了後、表示されるURLをコピーして LINE Webhook URL に設定する。

---

## 6. Firestore セキュリティルールのデプロイ

```bash
firebase deploy --only firestore:rules
```

---

## 7. ローカル開発環境

```bash
# 依存パッケージインストール
npm install

# Firebase サービスアカウントキーをダウンロードして配置
# Firebase Console → プロジェクト設定 → サービスアカウント
# → 新しい秘密鍵を生成 → serviceAccountKey.json として保存

# .env を設定
cp .env.example .env
# .env を編集して各値を入力

# LINE Webhook のローカルテスト用にngrokを使う
npx ngrok http 8080
# 表示されたhttps://xxxxx.ngrok.io/webhook を LINE Webhook URLに設定

# サーバー起動
npm run dev
```

---

## 8. データベース構造（Firestore）

```
/users/{lineUserId}
  - lineUserId: string
  - displayName: string
  - plan: "free" | "pro"
  - state: string  // LINEの会話状態
  - registeredAt: timestamp
  - bankAccount: {...}  // 口座情報（暗号化）

/properties/{propertyId}
  - propertyName: string
  - propertyType: string
  - address: string
  - price: number
  - area: number
  - yieldRate: number
  - submittedBy: string  // lineUserId
  - status: "draft"|"active"|"negotiating"|"contracted"|"closed"
  - merits: string[]
  - demerits: string[]
  - risks: string[]
  - createdAt: timestamp

/flowVerifications/{propertyId}
  - propertyId: string
  - propertyName: string
  - chain: Array<{userId, role, verifiedAt}>
  - flowCode: string
  - status: "in_progress"|"reached_seller"|"completed"

/requests/{requestId}
  - userId: string
  - text: string
  - budget: number
  - area: string
  - propertyType: string
  - status: "open"|"matched"|"closed"

/rewards/{rewardId}
  - userId: string
  - propertyId: string
  - percentage: number
  - amount: number
  - status: "pending"|"confirmed"|"paid"
  - paidAt: timestamp
```

---

## 9. 費用目安（月額）

| サービス | 無料枠 | 超過時 |
|---------|--------|--------|
| Cloud Run | 200万リクエスト/月 | ¥0.3/千リクエスト |
| Firestore | 50,000読取/日 | ¥3/10万読取 |
| LINE Messaging API | 200通/月 | ¥3/通（追加） |
| OpenAI GPT-4o | なし | 約¥2/物件解析1回 |

**月100件の物件登録・300名会員規模で概算 ¥3,000〜¥8,000/月**

---

## 10. セキュリティチェックリスト

- [ ] LINE署名検証（`x-line-signature`）実装済み
- [ ] 環境変数はSecret Managerで管理
- [ ] serviceAccountKey.json は `.gitignore` に追加済み
- [ ] Firestoreセキュリティルール設定済み
- [ ] HTTPS通信のみ（Cloud Runは自動）
- [ ] 個人情報（身分証）は別途暗号化ストレージに保存
